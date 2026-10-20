import http from 'node:http';
import { isPractice, checkBooksMode, practiceBanner } from '../../lib/domain/practice.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../lib/db.js';
import { HttpError, idParam, clientIp, tooMany } from './http.js';
import {
  isDemo, checkDemoMode, demoBanner, demoBlock, demoPublicBlock, DEMO_ACTOR, DEMO_ROBOTS, DEMO_UPLOADS_OFF, DEMO_WRITES_PER_IP, DEMO_WRITES_ALL,
  DEMO_HEAVY, DEMO_BULK, DEMO_MGMT_SECTIONS, DEMO_HEAVY_PER_IP, DEMO_HEAVY_ALL, DEMO_HEAVY_AT_ONCE, DEMO_REPORT_YEARS, DEMO_BATCH_MAX, DEMO_FORMS_PER_SESSION, DEMO_CHECK_MS,
} from '../../lib/domain/demo.js';
import { guardDatabase, demoProblems, readMarker } from '../../lib/data/demo.js';
import { vendorRoutes, VENDOR_UPLOAD_PATH } from './vendor-routes.js';
import { publicVendorInfo } from './vendor-auto-routes.js';
import { userRoutes, publicInvite, COMPANY_UPLOAD_PATH } from './user-routes.js';
import { salesSettingsRoutes } from './sales-settings-routes.js';
import { accountingRoutes } from './accounting-routes.js';
import { ledgerToolsRoutes } from './ledger-tools-routes.js';
import { loanRoutes } from './loan-routes.js';
import { taxRoutes } from './tax-routes.js';
import { toolsRoutes, IMPORT_UPLOAD_PATH } from './tools-routes.js';
import { timeRoutes } from './time-routes.js';
import { publicPay, paymentsSettingsRoutes } from './pay-routes.js';
import { currencyRoutes } from './currency-routes.js';
import { reportRoutes } from './report-routes.js';
import { mgmtRoutes } from './mgmt-routes.js';
import { insightRoutes } from './insight-routes.js';
import { trackActor, withActor, setActor, logSignIn } from '../../lib/audit.js';
import { partyCurrencyChoices, multicurrencyOn, rateOn } from '../../lib/data/currencies.js';
import { checkSignIn, sessionUser } from '../../lib/data/users.js';
import { LockBusyError, MorningTimeoutError, withSecurityWrite } from '../../lib/data/morning/locks.js';
import { MorningAccessError, appOrg, trustedActor, currentViewer, ensureOwnerViewer } from '../../lib/data/morning/access.js';
import { ProtectedIdentityError, protectedState, revokeMembershipIn } from '../../lib/data/morning/identity.js';
import { ownerUserIdFromEnv, validateOwnerAccount } from '../../lib/owner-account.js';
import { randomBytes } from 'node:crypto';
import { matchMorningRoute } from '../../lib/domain/morning-paths.js';
import { morningRoutes, morningCan, filterVisibleLinks, FORBIDDEN_FIELDS } from './morning-routes.js';
import { canAccess, homeFor } from '../../lib/domain/roles.js';
import { createAuth, sameToken } from '../../lib/auth.js';
import { todayIn } from '../../lib/domain/dates.js';
import { parseTxnFilters } from '../../lib/domain/filters.js';
import { parseMoney, centsToInput, formatCents } from '../../lib/domain/money.js';
import { TYPE_LABELS } from '../../lib/domain/status.js';
import { listCustomers, getCustomer, getSummary } from '../../lib/data/customers.js';
import { listTransactions, getTransaction } from '../../lib/data/transactions.js';
import { listActivity } from '../../lib/data/activity.js';
import {
  ValidationError, saveSalesDoc, savePayment, applyCredit, voidTxn, deleteTxn, saveCustomer, setEstimateStatus,
  listItems, listTerms, listOpenCharges, writeCustomerOpening, setCustomersActive, mergeCustomers,
} from '../../lib/data/writes.js';
import { getEntity, transactionsPdf, sendTransaction, listMessages, sendCustomerEmail, logReply, sendReminderNow } from '../../lib/data/messages.js';
import {
  createStatement, listStatements, getStatement, statementPdf, statementPreviewPdf, sendStatement, statementFilename,
} from '../../lib/data/statements.js';
import { addDays, setDateFormat } from '../../lib/domain/dates.js';
import { setShowAccountNumbers } from '../../lib/views/accounts.js';
import {
  listTemplates, getTemplate, saveTemplate, setTemplateActive, deleteTemplate, templateLineRows,
} from '../../lib/data/recurring.js';
import { getPolicy, savePolicy, setCustomerLateFees, listCustomerLateFees } from '../../lib/data/latefees.js';
import { listTermsWithUse, saveTerms, deleteTerms, listAllItems, getItem, saveItem } from '../../lib/data/catalog.js';
import { runDailyJobs } from '../jobs/index.js';
import { processMorningRuntime } from '../../lib/data/morning/locks.js';
import { listProjects, getProject, listProjectTransactions, saveProject, deleteProject } from '../../lib/data/projects.js';
import {
  listDocuments, listTxnDocuments, getDocument, addDocument, deleteDocument, downloadType, attachmentHeader, MAX_DOCUMENT_BYTES,
} from '../../lib/data/documents.js';
import { boundaryOf, parseMultipart, MultipartError } from '../../lib/multipart.js';
import { projectPage, projectToValues, projectFormValues } from '../../lib/views/projects.js';
import { getSalesSettings } from '../../lib/data/sales-settings.js';
import { invoiceFromEstimate } from '../../lib/data/estimates.js';
import { createPayLink } from '../../lib/data/online-payments.js';
import { listRules } from '../../lib/data/price-rules.js';
import { dimensionChoices, unbilledExpenses, billableLines, getAccountingSettings, listTags } from '../../lib/data/accounting.js';
import { dimsFromForm, dimsForSave } from './dims.js';
import { unbilledTime, timeLines } from '../../lib/data/time.js';
import { getEmailSettings, saveEmailSettings, recordEmailTest, mailerFor } from '../../lib/data/settings.js';
import { settingsKey } from '../../lib/secrets.js';
import { transactionsWorkbook, exportFilename } from '../../lib/export.js';
import { loginPage } from '../../lib/views/login.js';
import { messagePage } from '../../lib/views/layout.js';
import { appNav } from '../../lib/views/nav.js';
import { withDisplay } from '../../lib/domain/display.js';
import { getNav } from '../../lib/data/nav.js';
import { navRoutes } from './nav-routes.js';
import { companyRoutes } from './company-routes.js';
import { bankFeedRoutes } from './bankfeed-routes.js';
import { bankingRoutes, BANK_UPLOAD_PATH } from './banking-routes.js';
import { chosen, safeBack } from '../../lib/domain/save-choices.js';
import { preferredChoice, rememberChoice } from '../../lib/data/form-prefs.js';
import { aiRoutes } from './ai-routes.js';
import { txnExtrasRoutes } from './txn-extras-routes.js';
import { IMPORTED_LOCKED, isImported } from '../../lib/views/txn-extras.js';
import { salesExtrasRoutes } from './sales-extras-routes.js';
import { receiptRoutes, publicSms } from './receipt-routes.js';
import { ledgerlinePool, assignTenant } from '../../lib/bankfeed/source.js';
import { runBankPulls } from '../../lib/bankfeed/pull.js';
import { listRoutes } from './list-routes.js';
import { customersPage } from '../../lib/views/customers.js';
import { customerPage, TABS, shareLinkPage, confirmBatchDeletePage } from '../../lib/views/customer-page.js';
import { txnPage } from '../../lib/views/txn-view.js';
import { salesDocForm, paymentForm, partyAddress } from '../../lib/views/txn-form.js';
import { customerForm, customerToValues, customerFormValues, NEW_CUSTOMER_VALUES, customerMergePage } from '../../lib/views/customer-form.js';
import {
  settingsIndexPage, emailSettingsPage, emailToValues, emailFormValues, settingsLayout,
} from '../../lib/views/settings.js';
import { templateForm, templateToValues, templateFormValues, newTemplateValues } from '../../lib/views/recurring.js';
import {
  lateFeeSettingsBody, policyToValues, policyFormValues, termsSettingsBody, itemsSettingsBody, itemFormBody, itemToValues, itemFormValues, adjustQuantityBody,
} from '../../lib/views/latefees.js';
import { adjustQuantity, itemHistory, scaled as scaledQty } from '../../lib/data/inventory.js';
import { EMAIL } from '../../lib/data/writes.js';
import {
  listAccounts, getAccount, saveAccount, deleteAccount, accountRegister, ledgerCheck, accountsOfTypes, systemAccounts,
} from '../../lib/data/ledger.js';
import { listUndeposited, listDeposits, getDeposit, saveDeposit, deleteDeposit } from '../../lib/data/deposits.js';
import { chartOfAccountsBody, accountFormBody, accountToValues, accountFormValues, NEW_ACCOUNT, registerBody } from '../../lib/views/accounts.js';
import { depositsPage, depositForm, depositFormValues, depositPage } from '../../lib/views/deposits.js';
import { renderDepositSlipPdf } from '../../lib/pdf/deposit-slip.js';
import { getBillSettings, saveBillSettings } from '../../lib/data/payables.js';
import { projectCosts } from '../../lib/data/payables-read.js';
import { billSettingsBody } from '../../lib/views/bill-settings.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const STATIC = {
  'app.css': 'text/css; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'manifest.webmanifest': 'application/manifest+json',
  'icons/icon-192.png': 'image/png', 'icons/icon-512.png': 'image/png',
};
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const MAX_FORM_BYTES = 64 * 1024;
const RECENT_MAX = 8;
const BATCH_MAX = 200;
const SALES_TYPES = ['invoice', 'sales_receipt', 'credit_memo', 'estimate'];
// The one-time form id the forms render (lib/views/forms.js csrfField): 12 random bytes, base64url. Nothing else is kept.
const FORM_ONCE = /^[A-Za-z0-9_-]{16}$/;
const DEMO_TOO_MANY_WRITES = 'That’s a lot of changes in a short time for this public demo. Wait a few minutes and try again.';
const NEW_TYPES = [...SALES_TYPES, 'payment'];


async function readBody(req, limit, tooLarge) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, tooLarge);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readForm = async req => new URLSearchParams((await readBody(req, MAX_FORM_BYTES, 'Form too large')).toString('utf8'));
const UPLOAD_PATH = /^\/customers\/\d{1,18}\/documents$|^\/vtxns\/read$/; // stage F6: a bill or receipt uploaded on a vendor form

const safeNext = next => (typeof next === 'string' && /^\/(?!\/)[\w\-./?=&%]*$/.test(next) ? next : '/customers');
const txnName = t => `${TYPE_LABELS[t.type]} ${t.doc_number ?? t.payment_ref ?? ''}`.trim();

// ---- form <-> values ----

// Rows copied from a spreadsheet: tab-separated (Excel, Sheets), else comma-separated; at most 100.
export function pastedRows(text) {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n').map(s => s.trimEnd()).filter(s => s.trim());
  return raw.slice(0, 100).map(line => (line.includes('\t') ? line.split('\t') : line.split(',')).map(c => c.trim().replace(/^"(.*)"$/, '$1').replace(/^\$/, '')));
}

function salesValuesFromForm(params) {
  const items = params.getAll('line_item'), desc = params.getAll('line_desc'), qty = params.getAll('line_qty'), rate = params.getAll('line_rate');
  const service = params.getAll('line_service'), est = params.getAll('line_est'), bill = params.getAll('line_bill'), cls = params.getAll('line_class');
  const time = params.getAll('line_time'), kinds = params.getAll('line_kind');
  const n = Math.min(100, Math.max(items.length, desc.length, qty.length, rate.length));
  const lines = Array.from({ length: n }, (_, i) => ({ kind: ['subtotal', 'text'].includes(kinds[i]) ? kinds[i] : 'item', itemId: items[i] ?? '', description: desc[i] ?? '',
    quantity: qty[i] ?? '', rate: rate[i] ?? '', serviceDate: service[i] ?? '', estimateLine: est[i] ?? '', billable: bill[i] ?? '', classId: cls[i] ?? '', timeEntry: time[i] ?? '' }))
    .filter(l => l.kind === 'subtotal' || l.itemId || l.description.trim() || l.quantity.trim() || l.rate.trim());
  // Lines pasted from a spreadsheet (stage F3; the page fills them in, this is the no-JavaScript way): product, description, qty, rate.
  for (const row of pastedRows(params.get('paste_lines'))) lines.push({ kind: 'item', itemId: '', itemName: row[0], description: row[1] ?? '', quantity: row[2] ?? '', rate: row[3] ?? '',
    serviceDate: '', estimateLine: '', billable: '', classId: '', timeEntry: '' });
  const get = k => params.get(k) ?? '';
  return { customerId: get('customer_id'), txnDate: get('txn_date'), dueDate: get('due_date'), termsId: get('terms_id'), docNumber: get('doc_number'),
    memo: get('memo'), paymentMethod: get('payment_method'), paymentRef: get('payment_ref'), projectId: get('project_id'), depositToId: get('deposit_to'), lines,
    discountKind: get('discount_kind') === 'amount' ? 'amount' : 'percent', discountValue: get('discount_value'), shipping: get('shipping'),
    depositAmount: get('deposit_amount'), depositMethod: get('deposit_method'), afterSave: ['email', 'print'].includes(get('after_save')) ? get('after_save') : 'none',
    hasDeposit: params.has('deposit_amount'), estimateId: get('estimate_id'), exchangeRate: get('exchange_rate'), ...dimsFromForm(params),
    // Stage F4 fields (only sent by forms that show them).
    extras: params.has('extras') ? { cc: get('email_cc'), bcc: get('email_bcc'), billTo: get('bill_to'), shipTo: get('ship_to'), shipVia: get('ship_via'), shipDate: get('ship_date'),
      trackingNo: get('tracking_no'), poNumber: get('po_number'), internalNote: get('internal_note'), statementMemo: get('statement_memo'),
      printLater: get('print_later') === '1', sendLater: get('send_later') === '1', acceptedBy: get('accepted_by'), acceptedDate: get('accepted_date'),
      depositRequest: get('deposit_request') } : null };
}

function salesValuesFromTxn(t, { copy = false, today } = {}) {
  return {
    customerId: String(t.customer_id), txnDate: copy ? today : t.txn_date, dueDate: copy ? '' : (t.due_date ?? ''),
    docNumber: copy ? '' : (t.doc_number ?? ''), memo: t.memo ?? '', paymentMethod: t.payment_method ?? '', paymentRef: copy ? '' : (t.payment_ref ?? ''),
    projectId: t.project_id ? String(t.project_id) : '', depositToId: t.account_id ? String(t.account_id) : '',
    termsId: copy || !t.terms_id ? '' : String(t.terms_id),
    discountKind: t.discount_percent ? 'percent' : 'amount',
    discountValue: t.discount_percent ? String(Number(t.discount_percent)) : (Number(t.discount_cents) ? centsToInput(t.currency ? Number(t.foreign_discount_cents ?? 0) : t.discount_cents) : ''),
    shipping: Number(t.shipping_cents) ? centsToInput(t.currency ? Number(t.foreign_shipping_cents ?? 0) : t.shipping_cents) : '',
    depositAmount: !copy && t.deposit_cents ? centsToInput(t.deposit_cents) : '', depositMethod: !copy && t.deposit_method ? t.deposit_method : '', afterSave: 'none',
    exchangeRate: !copy && t.currency ? String(Number(t.exchange_rate)) : '',
    lines: t.lines.map(l => ({ kind: l.kind ?? 'item', itemId: l.item_id ? String(l.item_id) : '', description: l.description ?? '', quantity: String(l.quantity),
      rate: centsToInput(t.currency && l.foreign_rate_cents !== null ? l.foreign_rate_cents : l.rate_cents),
      serviceDate: l.service_date ?? '', classId: l.class_id ? String(l.class_id) : '',
      billable: !copy && l.billable_txn_id ? `${l.billable_txn_id}:${l.billable_line_no}` : '', timeEntry: !copy && l.time_entry_id ? String(l.time_entry_id) : '' })),
    classId: t.class_id ? String(t.class_id) : '', locationId: t.location_id ? String(t.location_id) : '', tagIds: (t.tag_ids ?? []).map(String),
    extras: { cc: t.email_cc ?? '', bcc: t.email_bcc ?? '', billTo: t.bill_to ?? '', shipTo: t.ship_to ?? '', shipVia: t.ship_via ?? '', shipDate: copy ? '' : (t.ship_date ?? ''),
      trackingNo: copy ? '' : (t.tracking_no ?? ''), poNumber: copy ? '' : (t.po_number ?? ''), internalNote: t.internal_note ?? '', statementMemo: t.statement_memo ?? '',
      printLater: !copy && t.print_later === true, sendLater: !copy && t.send_later === true, acceptedBy: copy ? '' : (t.accepted_by ?? ''), acceptedDate: copy ? '' : (t.accepted_date ?? ''),
      depositRequest: t.deposit_request_percent ? String(Number(t.deposit_request_percent)) : '' },
  };
}

function paymentValuesFromForm(params) {
  const get = k => params.get(k) ?? '';
  const apply = {};
  for (const [k, val] of params) if (/^apply_\d{1,18}$/.test(k) && val.trim()) apply[k.slice(6)] = val.trim();
  return { customerId: get('customer_id'), txnDate: get('txn_date'), paymentMethod: get('payment_method'), paymentRef: get('payment_ref'), amount: get('amount'), memo: get('memo'), apply,
    exchangeRate: get('exchange_rate'), depositToId: get('deposit_to') };
}

function parseApplications(apply) {
  return Object.entries(apply).map(([id, text]) => {
    const cents = parseMoney(text);
    if (cents === null) throw new ValidationError(`“${text}” isn’t an amount. Use numbers like 125.00.`);
    return { chargeTxnId: Number(id), amountCents: cents };
  }).filter(a => a.amountCents > 0);
}

// `mailer` forces one mailer for every send (tests); otherwise each company's Settings → Email decides.
// `makeTransport` replaces nodemailer's SMTP transport (tests).
// demoCheckMs, demoHeavyAtOnce: how often the public demo re-checks its database, and how many expensive pages it builds at
// once (tests change them).
export function createApp({ pool, env = process.env, now = () => new Date(), mailer = null, makeTransport = undefined, ledgerline = null, aiFetch = undefined, smsFetch = undefined,
  userRoutesTestHooks = {}, morningTestHooks = {}, onAuthenticatedForTest, morningRuntime = processMorningRuntime,
  demoCheckMs = DEMO_CHECK_MS, demoHeavyAtOnce = DEMO_HEAVY_AT_ONCE }) {
  const ownerUserId = ownerUserIdFromEnv(env);
  if (env.NODE_ENV === 'production' && (Object.keys(userRoutesTestHooks).length || Object.keys(morningTestHooks).length || onAuthenticatedForTest)) throw new Error('Test hooks are not allowed in production');
  // The public demo (lib/domain/demo.js): no sign-in, and nothing reaches the outside world — no bank-data source, no AI
  // or Twilio calls, and every email only recorded (mailerFor; an injected mailer is ignored too).
  const demo = isDemo(env);
  if (demo) {
    checkDemoMode(env); // refuses a real server's settings
    const off = () => Promise.reject(new Error('This is turned off in the public demo.'));
    ledgerline = null; aiFetch = off; smsFetch = off; mailer = null;
    makeTransport = () => { throw new Error('Email is never sent from the public demo.'); };
  }
  const orgSlug = env.APP_ORG || 'sample';
  const cursorSecret = randomBytes(32);
  const morningReady = appOrg(pool, orgSlug).then(async org => {
    await validateOwnerAccount(pool, { ownerUserId, orgId: org?.orgId });
    if (org) {
      await ensureOwnerViewer(pool, org.orgId);
      if (ownerUserId !== null) await withSecurityWrite(pool, { orgId: org.orgId, userIds: [ownerUserId] }, async tx => {
        if (await protectedState(tx, { orgId: org.orgId, userId: ownerUserId })) {
          await revokeMembershipIn(tx, { orgId: org.orgId, viewerKey: String(ownerUserId) });
        }
      });
    }
    return org;
  });
  morningReady.catch(() => {}); // The request awaits and reports bootstrap failures.
  const httpsOnly = /^https:\/\//.test(env.APP_BASE_URL ?? '');
  // Every write the app makes is recorded in the audit log under the person making it.
  trackActor(pool);
  const auth = createAuth({ env, demo, now: () => now().getTime(),
    verifyUser: ({ email, password, code }) => checkSignIn(pool, { orgSlug, email, password, code, key: settingsKey(env), now: now() }) });
  // The break-glass owner (environment login, or DEV_NO_AUTH): always an admin.
  // In the public demo every visitor is this owner, named "Demo visitor" in the audit log.
  const owner = { userId: null, name: demo ? DEMO_ACTOR : env.APP_OPERATOR_NAME || 'operator', role: 'admin', canApproveBills: true, owner: true };

  // The company this request works in: the one chosen in the session (Switch company), if the person may open it, else
  // the first they may open. `companies` lists every company they can switch to.
  async function context(session = null, who = null) {
    const { rows } = await pool.query(
      `SELECT o.org_id, e.entity_id, e.name AS entity_name, e.time_zone
         FROM org o JOIN entity e ON e.org_id = o.org_id WHERE o.slug = $1 ORDER BY lower(e.name), e.entity_id`, [orgSlug]);
    if (!rows.length) {
      throw new HttpError(503, env.NODE_ENV === 'production' ? 'There are no companies in these books yet. They’re being set up; check back soon.'
        : `No books found for org "${orgSlug}". Run npm run seed, or import a company.`);
    }
    const companies = !who || who.owner || who.allCompanies !== false ? rows : rows.filter(r => who.companyIds?.includes(Number(r.entity_id)));
    if (!companies.length) throw new HttpError(403, 'You don’t have access to any company yet. Ask an admin to add you to one.');
    const r = companies.find(c => Number(c.entity_id) === Number(session?.entityId)) ?? companies.find(c => Number(c.entity_id) === Math.min(...rows.map(x => Number(x.entity_id)))) ?? companies[0];
    if (session) session.entityId = Number(r.entity_id);
    const acct = await getAccountingSettings(pool, { orgId: r.org_id, entityId: r.entity_id });
    setDateFormat(acct.dateFormat);
    setShowAccountNumbers(acct.showAccountNumbers);
    return { orgId: r.org_id, entityId: r.entity_id, entityName: r.entity_name, timeZone: r.time_zone, today: todayIn(r.time_zone, now()),
      companies: companies.map(c => ({ entityId: Number(c.entity_id), name: c.entity_name })),
      // Organization-level admin: the owner, or an admin who can open every company. Only they manage people, company
      // access and the list of companies; an admin limited to some companies administers just those companies' books.
      orgAdmin: !who || who.owner || (who.role === 'admin' && who.allCompanies !== false) };
  }

  // A practice copy says so on every HTML page it sends — signed in or not, errors included (lib/domain/practice.js); so
  // does the public demo (lib/domain/demo.js), which also asks search engines to keep out.
  const practice = isPractice(env);
  const banner = practice ? practiceBanner() : demo ? demoBanner() : null;
  const marked = (body, type) => {
    if (!banner || !/^text\/html/.test(type) || Buffer.isBuffer(body)) return body;
    const s = String(body);
    if (!s || s.includes('class="practice-banner')) return s;
    return /<body[^>]*>/.test(s) ? s.replace(/<body[^>]*>/, open => open + banner) : banner + s;
  };
  // Every response's headers, streamed ones too (the attachments ZIP): security headers, no caching, noindex in the demo.
  const headersFor = (headers = {}) => ({ ...SECURITY_HEADERS, ...(httpsOnly ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    ...(demo ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}), 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8', ...headers });
  function send(res, status, body, headers = {}) {
    const all = headersFor(headers);
    res.writeHead(status, all);
    const out = marked(body, all['Content-Type']);
    res.end(typeof out === 'string' || Buffer.isBuffer(out) ? out : String(out));
  }
  const redirect = (res, location, headers = {}) => send(res, 303, '', { Location: location, ...headers });

  // The public demo re-checks its database now and then (lib/data/demo.js): if it ever stops being a clean demo the app
  // stops serving it, and when the nightly reset has run every visitor session starts afresh (nothing a visitor left in
  // memory outlives the reset).
  let demoCheck = { at: -Infinity, ok: false, resetAt: undefined }, demoChecking = null;
  async function demoReady() {
    if (Date.now() - demoCheck.at < demoCheckMs) return demoCheck.ok;
    demoChecking ??= (async () => {
      try {
        const problems = await demoProblems(pool);
        const resetAt = (await readMarker(pool))?.reset_at?.toISOString() ?? null;
        if (demoCheck.resetAt !== undefined && resetAt !== demoCheck.resetAt) auth.reset();
        if (!problems.length && resetAt !== demoCheck.resetAt) {
          const org = await appOrg(pool, orgSlug);
          if (org) await ensureOwnerViewer(pool, org.orgId);
        }
        if (problems.length && demoCheck.ok !== false) console.error(`demo: not serving — this database is no longer a clean demo: ${problems.join('; ')}`);
        demoCheck = { at: Date.now(), ok: !problems.length, resetAt };
      } catch (error) {
        console.error(`demo: database check failed: ${error.message}`);
        demoCheck = { ...demoCheck, at: Date.now(), ok: false };
      } finally { demoChecking = null; }
    })();
    await demoChecking;
    return demoCheck.ok;
  }
  // Expensive pages being built right now in the demo.
  let heavyNow = 0;
  const pdf = (res, body, filename) => send(res, 200, body, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"` });

  async function routes(req, res) {
    const configuredOrg = await morningReady;
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);

    if (req.method === 'GET' && path === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (demo) {
      if (req.method === 'GET' && path === '/robots.txt') return send(res, 200, DEMO_ROBOTS, { 'Content-Type': 'text/plain; charset=utf-8' });
      // Nobody signs in or out of the demo; links that reach outside people or services are closed.
      if (path === '/login' || path === '/logout') return redirect(res, '/');
      const closed = demoPublicBlock(path);
      if (closed) { setActor(DEMO_ACTOR); throw new HttpError(403, closed); }
      if (!(await demoReady())) throw new HttpError(503, 'The demo isn’t available right now. Try again in a few minutes.');
    }

    if (req.method === 'GET' && path.startsWith('/public/')) {
      const name = path.slice('/public/'.length);
      if (!Object.hasOwn(STATIC, name)) throw new HttpError(404, 'Not found');
      return send(res, 200, await readFile(PUBLIC_DIR + name), { 'Content-Type': STATIC[name], 'Cache-Control': 'no-cache' });
    }

    // The service worker must be served from the root to control the whole app.
    if (req.method === 'GET' && path === '/sw.js') {
      return send(res, 200, await readFile(PUBLIC_DIR + 'sw.js'), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    }

    // The page a vendor opens from an "Ask vendor for info" email: no sign-in, single-use link.
    if (path.startsWith('/vendor-info/')) setActor('Vendor (info link)');
    // Texted receipts: Twilio's signed webhook.
    if (path === '/twilio/sms') { setActor('Text receipt'); return publicSms({ req, res, pool, env, send, readForm, smsFetch, aiFetch }); }
    if (path.startsWith('/invite/')) setActor('Invited user');
    if (path.startsWith('/pay/') || path.startsWith('/webhooks/payments/')) setActor('Online payment');
    if (path.startsWith('/vendor-info/')) return publicVendorInfo({ req, res, path, pool, env, send, readForm });
    // The page an invited person opens to set their password and authenticator.
    if (path.startsWith('/invite/')) return publicInvite({ req, res, path, pool, env, send, readForm, auth, now, orgSlug, ownerUserId });
    // Online invoice payments: the customer's pay page, the test processor's checkout, and the processor's signed webhook.
    if (path.startsWith('/pay/') || path.startsWith('/webhooks/payments/')) {
      // A practice copy takes no money: customers pay through QuickBooks until the company goes live.
      if (isPractice(env)) return send(res, 403, 'Online payments are off in this practice copy of the books.', { 'Content-Type': 'text/plain; charset=utf-8' });
      return publicPay({ req, res, path, pool, env, send, readForm, now, mailerFor: scope => (mailer ? Promise.resolve(mailer) : mailerFor(pool, { ...scope, env, makeTransport })) });
    }

    if (path === '/login') {
      const challenge = auth.loginChallenge(req);
      if (req.method === 'GET') return send(res, 200, String(loginPage({ challenge: challenge.value, next: safeNext(query.next) })), { 'Set-Cookie': challenge.setCookie });
      if (req.method === 'POST') {
        const form = Object.fromEntries(await readForm(req));
        const result = await auth.login(req, form, clientIp(req, env));
        const org = (await pool.query('SELECT org_id FROM org WHERE slug = $1', [orgSlug])).rows[0];
        // Sign-ins and real failed attempts are logged (not stale forms or rate-limited tries, so the log can't be flooded).
        if (org && (result.ok || result.attempted)) await logSignIn(pool, { orgId: org.org_id, email: String(form.email ?? '').trim().slice(0, 200) || 'owner', ok: Boolean(result.ok), ip: clientIp(req, env) });
        if (result.ok) return redirect(res, safeNext(form.next), { 'Set-Cookie': result.setCookie });
        return send(res, 401, String(loginPage({ challenge: challenge.value, error: result.error, next: safeNext(form.next), email: String(form.email ?? '').slice(0, 200) })),
          { 'Set-Cookie': challenge.setCookie });
      }
      throw new HttpError(405, 'Method not allowed');
    }

    const { session, setCookie } = auth.current(req);
    if (!session) {
      if (req.method === 'GET') return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`);
      throw new HttpError(401, 'Sign in first');
    }
    const extra = setCookie ? { 'Set-Cookie': setCookie } : {};
    // Who is signed in, reloaded on every request so deactivating someone or changing their role takes effect at once.
    const who = session.userId ? await sessionUser(pool, { userId: session.userId, version: session.version,
      orgId: configuredOrg?.orgId, ownerUserId }) : owner;
    if (who) setActor(who.name);
    if (!who) {
      const cleared = { 'Set-Cookie': auth.end(session) };
      if (req.method === 'GET') return redirect(res, `/login?next=${encodeURIComponent(path + url.search)}`, cleared);
      throw new HttpError(401, 'Sign in again');
    }
    const actor = who.name;
    if (session.userId && who.orgId !== configuredOrg?.orgId) {
      const cleared = { 'Set-Cookie': auth.end(session) };
      if (req.method === 'GET') return redirect(res, '/login', cleared);
      throw new HttpError(401, 'Sign in again');
    }
    if (onAuthenticatedForTest) await onAuthenticatedForTest({ who, session, orgId: configuredOrg?.orgId });
    const morningRoute = matchMorningRoute(req.method, path);
    if (morningRoute?.error) throw new HttpError(morningRoute.error, morningRoute.error === 405 ? 'Method not allowed' : 'Not found');
    const identity = configuredOrg ? trustedActor(who, configuredOrg.orgId, session, ownerUserId) : null;
    let morningViewer = null;
    if (identity) try { morningViewer = await currentViewer(pool, { identity }); } catch (error) {
      if (!(error instanceof MorningAccessError) || !['not_viewer','pending'].includes(error.reason)) throw error;
    }
    if (morningRoute && !morningViewer) throw new HttpError(403, 'Morning View is limited to the owner and one named viewer.');
    if (morningRoute?.ownerOnly && !morningViewer.isOwner) throw new HttpError(403, 'Only the owner can change this.');
    // The app's own address, for links in emails.
    const appOrigin = () => (env.APP_BASE_URL ? env.APP_BASE_URL.replace(/\/$/, '') : `http://${req.headers.host ?? '127.0.0.1'}`);
    // An admin ticked "change it anyway" on a reconciled transaction.
    // (Not in the public demo: a reconciled transaction stays as it is there.)
    const overrideOk = () => who.role === 'admin' && !demo && form?.get('edit_reconciled') === '1';
    if (!morningRoute && !canAccess(who.role, req.method, path)) {
      throw new HttpError(403, who.role === 'reports' && req.method !== 'GET' ? 'Your role can look but not change anything.' : 'Your role doesn’t include this page. Ask an admin if you need it.');
    }
    // The public demo: what could store a secret, reach outside or change how the server runs is closed (with the reason),
    // uploads are refused before they're read, writes are rate limited per visitor address (and, once the form is known
    // to be genuine, overall), and so are pages that take real work to build — of which only a few run at once.
    if (demo) {
      const why = demoBlock(req.method, path);
      if (why) throw new HttpError(403, why);
      const ip = clientIp(req, env);
      if (req.method === 'POST') {
        if (boundaryOf(req.headers['content-type'])) throw new HttpError(403, DEMO_UPLOADS_OFF);
        if (tooMany(`demo-write:${ip}`, DEMO_WRITES_PER_IP)) throw new HttpError(429, DEMO_TOO_MANY_WRITES);
      }
      if (DEMO_HEAVY.test(path)) {
        if (tooMany(`demo-heavy:${ip}`, DEMO_HEAVY_PER_IP) || tooMany('demo-heavy:all', DEMO_HEAVY_ALL)) {
          throw new HttpError(429, 'That’s a lot of reports and downloads in a short time for this public demo. Wait a few minutes and try again.');
        }
        if (heavyNow >= demoHeavyAtOnce) throw new HttpError(503, 'The demo is busy building other reports. Try again in a moment.');
        // The slot is given back only when both the work (the request handler) and the response are finished — a visitor
        // hanging up early doesn't free it while the report is still being built.
        heavyNow++;
        let open = 2;
        const release = () => { if (--open === 0) heavyNow--; };
        let handlerDone = false;
        req.demoSlotDone = () => { if (!handlerDone) { handlerDone = true; release(); } };
        // A visitor who hung up before the slot was taken (while the demo re-checked its database) already closed the
        // response: that side is done now, or the slot would never come back.
        if (res.destroyed || res.closed || req.destroyed) release();
        else res.once('close', release);
      }
    }
    const flashNext = (kind, text) => { session.flash = { kind, text: demo ? String(text ?? '').slice(0, 2000) : text }; };
    const takeFlash = () => { const f = session.flash ?? null; session.flash = null; return f; };

    let form = null, files = [];
    if (req.method === 'POST') {
      const boundary = boundaryOf(req.headers['content-type']);
      if (boundary) {
        if (!UPLOAD_PATH.test(path) && !VENDOR_UPLOAD_PATH.test(path) && !COMPANY_UPLOAD_PATH.test(path) && !IMPORT_UPLOAD_PATH.test(path) && !BANK_UPLOAD_PATH.test(path)) {
          throw new HttpError(415, 'Uploads are only accepted on a Documents tab, an import, a bank item or the company logo.');
        }
        try {
          ({ fields: form, files } = parseMultipart(await readBody(req, MAX_DOCUMENT_BYTES + 64 * 1024, 'That file is over the 10 MB limit.'), boundary));
        } catch (error) {
          if (error instanceof MultipartError) throw new HttpError(400, error.message);
          throw error;
        }
      } else form = await readForm(req);
      if (!sameToken(form.get('csrf'), session.csrf)) throw new HttpError(403, 'This form expired. Reload the page and try again.');
      if (demo && tooMany('demo-write:all', DEMO_WRITES_ALL)) throw new HttpError(429, DEMO_TOO_MANY_WRITES);
      // A reconciled transaction can't be changed "anyway" in the demo, on any form.
      if (demo) form.delete('edit_reconciled');
      // Print, send and batch actions take at most a batch's worth of selections in the demo.
      if (demo && DEMO_BULK.test(path)) {
        // A bank review "all N matching" (all=<action>:<N>) acts on N items without ticking them: it counts as N.
        const allN = Number(/^[a-z]+:(\d{1,9})$/.exec(form.get('all') ?? '')?.[1] ?? 0);
        const most = Math.max(0, allN, ...[...new Set(form.keys())].map(k => form.getAll(k).length));
        if (most > DEMO_BATCH_MAX) throw new HttpError(403, `The demo handles at most ${DEMO_BATCH_MAX} at a time. Choose fewer and try again.`);
      }
      if (morningRoute) for (const field of FORBIDDEN_FIELDS) if (form.has(field)) throw new HttpError(400, 'Unexpected field.');
      if (path === '/logout') return redirect(res, '/login', { 'Set-Cookie': auth.logout(req) });
      // The same rendered form sent twice (double tap, resend): the second is ignored. Checked and recorded in one
      // synchronous step, so two requests arriving together can't both pass; forgotten again if the first one failed.
      // Only the id shape the forms render is remembered (a few bytes each), never whatever a request sends.
      const once = FORM_ONCE.test(form.get('form_once') ?? '') ? form.get('form_once') : null;
      if (once && !morningRoute) {
        session.formsUsed ??= new Map();
        if (session.formsUsed.has(once)) {
          session.flash = { kind: 'ok', text: 'That was already sent, so the second submit was ignored.' };
          const back = (() => { try { const r = new URL(req.headers.referer ?? ''); return r.host === req.headers.host ? r.pathname + r.search : null; } catch { return null; } })();
          return redirect(res, back ?? '/');
        }
        session.formsUsed.set(once, Date.now());
        while (session.formsUsed.size > (demo ? DEMO_FORMS_PER_SESSION : 500)) session.formsUsed.delete(session.formsUsed.keys().next().value);
        // Nothing was done (a server error, 422: refused, shown again to fix, or no such page): the same form may be sent again.
        res.on('finish', () => { if (res.statusCode >= 500 || res.statusCode === 422 || res.statusCode === 404) session.formsUsed.delete(once); });
      }
    } else if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');

    if (morningRoute) {
      await morningTestHooks.afterRouteCheck?.({ identity, route: morningRoute });
      return morningRoutes({ req,res,path,query,form,pool,identity,route:morningRoute,session,send,extra,cursorSecret,now,runtime:morningRuntime,env,hooks:morningTestHooks,who });
    }
    const ctx = await context(session, who);
    // A signed-in person belongs to one organization; their session never opens another organization's books.
    if (session.userId && who.orgId !== ctx.orgId) {
      const cleared = { 'Set-Cookie': auth.end(session) };
      if (req.method === 'GET') return redirect(res, '/login', cleared);
      throw new HttpError(401, 'Sign in again');
    }
    const scope = { orgId: ctx.orgId, entityId: ctx.entityId };
    // Links to pages the person's role can't open are taken out of the page.
    const canNavigate = p => morningCan(p, morningViewer, x => canAccess(who.role, 'GET', x) && (ctx.orgAdmin || !/^\/settings\/(users|companies)(\/|$)/.test(x)));
    const visible = body => filterVisibleLinks(body, canNavigate);
    // The navigation for this person (lib/views/nav.js), swapped in for the simple header the layout leaves marked.
    const navData = await getNav(pool, { ...scope, who });
    navData.bookmarks = navData.bookmarks.filter(b => canNavigate(b.href.split(/[?#]/)[0]));
    const withNav = body => {
      const s = String(body);
      if (!s.includes('<!--fb:nav-top-->')) return s;
      const title = (/<title>([^<]*?)(?: · Financial Books)?<\/title>/.exec(s)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&#39;/g, '’').replace(/&quot;/g, '"').replace(/&lt;|&gt;/g, '');
      const nav = appNav({ ...navData, role: who.role, can: canNavigate, path, search: url.search, title, csrf: session.csrf, entityName: ctx.entityName,
        companies: ctx.companies, entityId: ctx.entityId,
        canBookmark: req.method === 'GET',
        panelOpen: !/(?:^|;\s*)fb_panel=0/.test(req.headers.cookie ?? '') });
      const swap = (text, mark, part) => text.replace(new RegExp(`<!--fb:${mark}-->[^]*?<!--/fb:${mark}-->`), () => String(part));
      return swap(swap(swap(s.replace('<body>', '<body class="with-nav">'), 'nav-top', nav.top), 'nav-rail', String(nav.rail) + String(nav.panel)), 'nav-bottom', nav.bottom);
    };
    const page = (body, status = 200) => send(res, status, withNav(visible(body)), extra);
    const base = () => ({ entityName: ctx.entityName, csrf: session.csrf, role: who.role, orgAdmin: ctx.orgAdmin, morningViewer: Boolean(morningViewer) });
    // Saving the QBO way (stage F1): the person's main save choice for a form, and where "close" returns to — the page the
    // form was opened from (this app only; never back into a form).
    const refererBack = () => {
      try {
        const r = new URL(req.headers.referer ?? '');
        if (r.host !== req.headers.host) return null;
        const p = r.pathname + r.search;
        return /\/(new|edit)(\?|$|\/)/.test(p) ? null : safeBack(p);
      } catch { return null; }
    };
    const saveOpts = async (type, fallback = null) => ({
      preferred: (await preferredChoice(pool, { orgId: ctx.orgId, userId: who.userId ?? null, type })) ?? fallback,
      back: safeBack(form?.get?.('back')) ?? safeBack(query?.back) ?? refererBack() ?? '' });
    const saveChoice = async type => {
      const choice = chosen(form, type);
      await rememberChoice(pool, { orgId: ctx.orgId, userId: who.userId ?? null, type, choice });
      return choice;
    };
    const go = (location, kind = null, text = null) => { if (kind) flashNext(kind, text); return redirect(res, location, extra); };
    const loadCustomer = async id => (await getCustomer(pool, { ...scope, id })) ?? (() => { throw new HttpError(404, 'Customer not found'); })();
    const loadTxn = async id => {
      const t = await getTransaction(pool, { orgId: ctx.orgId, id });
      if (!t || t.entity_id !== ctx.entityId) throw new HttpError(404, 'Transaction not found');
      return t;
    };
    const allCustomers = () => listCustomers(pool, scope);
    // QBO warns (doesn't block) when a customer's balance goes over their credit limit.
    const overLimit = async t => {
      if (!['invoice', 'late_fee'].includes(t.type) || !t.customer_id) return '';
      const c = await getCustomer(pool, { ...scope, id: t.customer_id });
      if (c?.credit_limit_cents === null || c?.credit_limit_cents === undefined) return '';
      const { openCents } = await getSummary(pool, { orgId: ctx.orgId, customerId: t.customer_id, today: ctx.today });
      return openCents > Number(c.credit_limit_cents) ? ` Heads up: ${c.display_name} now owes ${formatCents(openCents)}, over their ${formatCents(Number(c.credit_limit_cents))} credit limit.` : '';
    };
    const companyMailer = () => (mailer ? Promise.resolve(mailer) : mailerFor(pool, { ...scope, env, makeTransport }));
    const mailKind = async () => (mailer ? mailer.kind : (await getEmailSettings(pool, scope)).mode === 'smtp' ? 'smtp' : 'log');
    const sentText = (what, status) => ({ sent: `${what} emailed.`, logged: demo ? `${what} recorded as sent. This is the public demo, so no email actually went out.`
      : `${what} recorded as sent. Email isn’t set up yet (Settings → Email), so nothing actually went out.`,
      failed: `${what} could not be sent. See Conversations for the error.` })[status];

    // The customer page. `forms` carries values and errors to re-show (statement form, compose, reply).
    async function showCustomer(customer, { tab, forms = {}, status = 200 } = {}) {
      const id = customer.customer_id;
      const filters = parseTxnFilters(query, ctx.today);
      session.recent = [id, ...(session.recent ?? []).filter(x => x !== id)].slice(0, RECENT_MAX);
      const pageSize = 100;
      const [summary, txns, activity, everyone, statements, messages, kind, templates, policy, lateFees, projects, documents, txnChoices] = await Promise.all([
        getSummary(pool, { orgId: ctx.orgId, customerId: id, today: ctx.today }),
        tab === 'transactions' ? listTransactions(pool, { orgId: ctx.orgId, customerId: id, filters, today: ctx.today, pageSize }) : null,
        tab === 'activity' ? listActivity(pool, { orgId: ctx.orgId, customerId: id }) : [],
        allCustomers(),
        tab === 'statements' ? listStatements(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'conversations' ? listMessages(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'conversations' ? mailKind() : null,
        tab === 'recurring' ? listTemplates(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'late-fees' ? getPolicy(pool, scope) : null,
        tab === 'late-fees' ? listCustomerLateFees(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'projects' ? listProjects(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'documents' ? listDocuments(pool, { orgId: ctx.orgId, customerId: id }) : [],
        tab === 'documents' ? pool.query(
          `SELECT txn_id, type, doc_number, payment_ref, txn_date FROM txn WHERE org_id = $1 AND customer_id = $2
            ORDER BY txn_date DESC, txn_id DESC LIMIT 200`, [ctx.orgId, id]).then(r => r.rows) : [],
      ]);
      const byId = new Map(everyone.map(c => [c.customer_id, c]));
      const statementForm = forms.statement ?? {
        kind: ['balance_forward', 'open_item', 'transaction'].includes(query.kind) ? query.kind
          : tab === 'statements' ? (await getSalesSettings(pool, scope)).statementKind : 'balance_forward',
        statementDate: ctx.today, startDate: addDays(ctx.today, -30), endDate: ctx.today,
      };
      const unbilled = (await getAccountingSettings(pool, scope)).billableOn ? await unbilledExpenses(pool, { ...scope, customerId: id }) : [];
      const unbilledHours = await unbilledTime(pool, { ...scope, customerId: id });
      return page(customerPage({
        ...base(), flash: takeFlash(), unbilled, unbilledHours, timeZone: ctx.timeZone, today: ctx.today, customer, summary, tab, activity,
        parentName: customer.parent_customer_id ? byId.get(customer.parent_customer_id)?.display_name : null,
        everyone, sideSort: query.side === 'name' ? 'name' : 'recent',
        recent: session.recent.map(x => byId.get(x)).filter(Boolean), txns: txns && { ...txns, filters, pageSize, tags: await listTags(pool, scope) },
        statements, statementForm, messages, mailKind: kind, templates, policy, lateFees, projects, documents, txnChoices,
        projectForm: forms.project ?? null, uploadError: forms.uploadError ?? null,
        compose: forms.compose ?? { to: customer.email ?? '', subject: '', body: '' },
        reply: forms.reply ?? { from: customer.email ?? '', subject: '', body: '' },
      }), status);
    }

    // Renders the right editor for a type, with values and an optional error.
    // Undeposited Funds first, then bank accounts: where a sales receipt's money can go.
    async function depositChoices() {
      const [sys, banks] = await Promise.all([systemAccounts(pool, ctx.orgId, ctx.entityId), accountsOfTypes(pool, { ...scope, types: ['bank'] })]);
      return [{ account_id: sys.undeposited, name: 'Undeposited Funds' }, ...banks];
    }

    async function renderEditor({ type, txnId = null, v, error = null, status = 200, override = false }) {
      const customers = await allCustomers();
      // A foreign-currency customer: the editor works in their currency, at a rate (typed, or the one on the date).
      const mc = await multicurrencyOn(pool, scope);
      const code = mc && idParam(v.customerId) ? (await pool.query('SELECT currency FROM customer WHERE customer_id = $1', [idParam(v.customerId)])).rows[0]?.currency : null;
      const fx = code ? { code, rate: await rateOn(pool, { ...scope, code, date: v.txnDate || ctx.today }) } : null;
      if (type === 'payment') {
        const customerId = idParam(v.customerId);
        const charges = customerId ? await listOpenCharges(pool, { orgId: ctx.orgId, customerId, paymentTxnId: txnId }) : null;
        return page(paymentForm({ ...base(), txnId, customers, charges, v, error, override, fx, reloadOnCustomer: mc, save: await saveOpts('payment'), depositAccounts: await depositChoices() }), status);
      }
      const customerId = idParam(v.customerId);
      // A new form starts with the customer's Cc/Bcc and addresses (stage F4); the page refills them when the customer changes.
      if (!txnId && !v.extras && customerId) {
        const c = customers.find(x => Number(x.customer_id) === customerId);
        if (c) v = { ...v, extras: { cc: c.cc ?? '', bcc: c.bcc ?? '', billTo: partyAddress(c, c.billing_address),
          shipTo: partyAddress(c, c.shipping_same_as_billing === false ? c.shipping_address : c.billing_address) } };
      }
      const [items, terms, projects, sales] = await Promise.all([listItems(pool, scope), listTerms(pool, scope),
        customerId ? listProjects(pool, { orgId: ctx.orgId, customerId }) : [], getSalesSettings(pool, scope)]);
      const choices = projects.filter(pr => pr.status === 'in_progress' || String(pr.project_id) === String(v.projectId));
      const depositAccounts = type === 'sales_receipt' ? await depositChoices() : [];
      if (type === 'sales_receipt' && !v.depositToId) v = { ...v, depositToId: String(depositAccounts[0]?.account_id ?? '') };
      // Every active rule; the editor picks the one for the chosen customer, date and product.
      const priceRules = (await listRules(pool, scope)).filter(r => r.active).map(r => ({ name: r.name, kind: r.kind,
        price: r.price_cents === null ? null : Number(r.price_cents), off: r.percent_off, items: r.item_ids.map(Number), customers: r.customer_ids.map(Number),
        start: r.start_date, end: r.end_date }));
      const dims = await dimensionChoices(pool, scope);
      const unbilled = type === 'invoice' && customerId && !fx
        ? (dims.settings.billableOn ? (await unbilledExpenses(pool, { ...scope, customerId, exceptInvoiceId: txnId })).length : 0)
          + (await unbilledTime(pool, { ...scope, customerId })).length : 0;
      return page(salesDocForm({ ...base(), save: await saveOpts(type, type === 'invoice' && sales.defaultDelivery === 'email' ? 'send' : null), type, txnId, customers, items, terms, projects: choices, depositAccounts, v, error, sales, priceRules, dims, unbilled, override,
        fx, reloadOnCustomer: mc }), status);
    }

    // Saves an editor post. Returns the txn id or re-renders the form on a validation error.
    async function saveEditor({ type, txnId = null }) {
      if (type === 'payment') {
        const v = paymentValuesFromForm(form);
        try {
          const customerId = idParam(v.customerId) ?? (() => { throw new ValidationError('Choose a customer.'); })();
          const amountCents = parseMoney(v.amount);
          if (amountCents === null || amountCents === 0) throw new ValidationError('Enter the amount received, like 1250.00.');
          return await savePayment(pool, { ...scope, actor, txnId, customerId, txnDate: v.txnDate, amountCents, editReconciled: overrideOk(), exchangeRate: v.exchangeRate,
            paymentMethod: v.paymentMethod, paymentRef: v.paymentRef, memo: v.memo, applications: parseApplications(v.apply), depositToId: idParam(v.depositToId) });
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          await renderEditor({ type, txnId, v, error: error.message, status: 422, override: Boolean(error.reconciled && who.role === 'admin') });
          return null;
        }
      }
      const v = salesValuesFromForm(form);
      // Pasted lines name their product: find it among this company's products and services (else the name is the description).
      if (v.lines.some(l => l.itemName !== undefined)) {
        const byName = new Map((await listItems(pool, scope)).map(it => [it.name.toLowerCase(), String(it.item_id)]));
        v.lines = v.lines.map(l => (l.itemName === undefined ? l : (({ itemName, ...rest }) => {
          const id = byName.get(String(itemName).toLowerCase());
          return { ...rest, itemId: id ?? '', description: rest.description || (id ? '' : itemName) };
        })(l)));
      }
      try {
        const customerId = idParam(v.customerId) ?? (() => { throw new ValidationError('Choose a customer.'); })();
        return await saveSalesDoc(pool, { ...scope, actor, txnId, type, customerId, txnDate: v.txnDate, dueDate: v.dueDate || null,
          termsId: idParam(v.termsId), docNumber: v.docNumber, memo: v.memo, paymentMethod: v.paymentMethod, paymentRef: v.paymentRef, lines: v.lines,
          editReconciled: overrideOk(), exchangeRate: v.exchangeRate, projectId: idParam(v.projectId), depositToId: idParam(v.depositToId), discountKind: v.discountKind, discountValue: v.discountValue, shipping: v.shipping,
          ...(v.hasDeposit ? { deposit: { amountText: v.depositAmount, method: v.depositMethod } } : {}), estimateId: idParam(v.estimateId), dims: dimsForSave(v),
          extras: v.extras ?? undefined });
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        await renderEditor({ type, txnId, v, error: error.message, status: 422, override: Boolean(error.reconciled && who.role === 'admin') });
        return null;
      }
    }

    // Runs a write that may fail validation. On failure: flashes the message, redirects to `back`, returns { ok: false }.
    async function attempt(back, fn) {
      try { return { ok: true, value: await fn() }; } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        go(back, 'error', error.message);
        return { ok: false };
      }
    }

    if (req.method === 'GET' && path === '/') return go(homeFor(who.role));

    // ---- customers ----
    if (path === '/customers' && req.method === 'GET') {
      const search = (query.q ?? '').slice(0, 100);
      return page(customersPage({ ...base(), customers: await listCustomers(pool, { ...scope, search }), search, flash: takeFlash() }));
    }
    // The customer form (new or edit), with the lists it needs.
    const showCustomerForm = async ({ customerId = null, v, error = null, status = 200 }) => page(customerForm({ ...base(), customerId, v, error, today: ctx.today,
      terms: await listTerms(pool, scope), cur: await partyCurrencyChoices(pool, { ...scope, table: 'customer', ...(customerId ? { id: customerId } : {}) }),
      parents: (await allCustomers()).filter(c => c.customer_id !== customerId) }), status);
    if (path === '/customers/new' && req.method === 'GET') return showCustomerForm({ v: NEW_CUSTOMER_VALUES });
    if (path === '/customers' && req.method === 'POST') {
      const v = customerFormValues(form);
      try {
        const opening = String(v.openingBalance ?? '').trim();
        let openingCents = 0;
        if (opening) {
          openingCents = parseMoney(opening) ?? (() => { throw new ValidationError('Opening balance should be an amount like 1250.00.'); })();
          if (openingCents < 0) throw new ValidationError('Enter the opening balance as a positive amount.');
        }
        const asOf = String(v.openingAsOf ?? '').trim() || ctx.today;
        const afterCreate = openingCents > 0 ? (tx, customerId) => writeCustomerOpening(tx, { ...scope, customerId, txnDate: asOf, cents: openingCents, actor }) : null;
        const id = await saveCustomer(pool, { ...scope, actor, fields: { ...v, isNew: true }, afterCreate });
        const made = await loadCustomer(id);
        return go(`/customers/${id}`, 'ok', `Customer ${made.display_name} created.`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return showCustomerForm({ v, error: error.message, status: 422 });
      }
    }

    let m = /^\/customers\/(\d{1,18})(\/edit|\/batch|\/export\.xlsx|\/statements|\/messages|\/recurring|\/recurring\/new|\/late-fees|\/projects|\/documents|\/active|\/merge)?$/.exec(path);
    if (m) {
      const customer = await loadCustomer(Number(m[1]));
      const id = customer.customer_id;
      if (m[2] === '/edit' && req.method === 'GET') return showCustomerForm({ customerId: id, v: customerToValues(customer) });
      if (!m[2] && req.method === 'POST') {
        const v = customerFormValues(form);
        try {
          await saveCustomer(pool, { ...scope, actor, customerId: id, fields: v });
          return go(`/customers/${id}`, 'ok', 'Customer details saved.');
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return showCustomerForm({ customerId: id, v, error: error.message, status: 422 });
        }
      }
      // Edit ▾ → Make inactive / Make active.
      if (m[2] === '/active' && req.method === 'POST') {
        const active = form.get('active') === '1';
        await setCustomersActive(pool, { ...scope, ids: [id], active, actor });
        return go(`/customers/${id}`, 'ok', active ? `${customer.display_name} is active again.`
          : `${customer.display_name} is inactive. They’re hidden from lists and forms but their history stays.`);
      }
      // Edit ▾ → Merge contacts.
      if (m[2] === '/merge') {
        const choices = (await allCustomers()).filter(c => c.customer_id !== id);
        const counts = (await pool.query(`SELECT (SELECT count(*)::int FROM txn WHERE org_id = $1 AND customer_id = $2) AS transactions,
            (SELECT count(*)::int FROM document WHERE org_id = $1 AND customer_id = $2) AS documents,
            (SELECT count(*)::int FROM project WHERE org_id = $1 AND customer_id = $2) AS projects`, [ctx.orgId, id])).rows[0];
        if (req.method === 'GET') return page(customerMergePage({ ...base(), customer, choices, counts }));
        if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
        try {
          const r = await mergeCustomers(pool, { ...scope, fromId: id, intoId: idParam(form.get('into')) ?? 0, actor });
          return go(`/customers/${r.into.customer_id}`, 'ok', `${r.from.display_name} merged into ${r.into.display_name}. ${r.moved.transactions} transactions moved.`);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return page(customerMergePage({ ...base(), customer, choices, counts, error: error.message }), 422);
        }
      }
      if (m[2] === '/batch' && req.method === 'POST') {
        const ids = [...new Set(form.getAll('ids').map(idParam).filter(Boolean))].slice(0, BATCH_MAX);
        const back = `/customers/${id}`;
        if (!ids.length) return go(back, 'error', 'Select at least one transaction first.');
        const owned = await pool.query('SELECT txn_id FROM txn WHERE org_id = $1 AND customer_id = $2 AND txn_id = ANY($3::bigint[])', [ctx.orgId, id, ids]);
        if (owned.rowCount !== ids.length) throw new HttpError(404, 'Transaction not found');
        if (form.get('action') === 'print') return pdf(res, await transactionsPdf(pool, { ...scope, txnIds: ids }), 'transactions.pdf');
        const picked = (await pool.query('SELECT txn_id, type, voided_at, open_cents, doc_number, payment_ref FROM txn WHERE org_id = $1 AND txn_id = ANY($2::bigint[]) ORDER BY txn_date, txn_id',
          [ctx.orgId, ids])).rows;
        if (form.get('action') === 'packing') {
          const slips = picked.filter(t => ['invoice', 'sales_receipt', 'estimate'].includes(t.type) && !t.voided_at).map(t => t.txn_id);
          if (!slips.length) return go(back, 'error', 'Packing slips are for invoices, sales receipts and estimates.');
          return pdf(res, await transactionsPdf(pool, { ...scope, txnIds: slips, packingSlip: true }), 'packing-slips.pdf');
        }
        if (form.get('action') === 'reminder') {
          const ready = await attempt(back, companyMailer);
          if (!ready.ok) return;
          const counts = { sent: 0, logged: 0, failed: 0 }, problems = [];
          for (const t of picked) {
            try { counts[await sendReminderNow(pool, ready.value, { ...scope, txnId: t.txn_id, actor })]++; } catch (error) {
              if (error instanceof ValidationError) problems.push(error.message);
              else { console.error(`batch reminder txn ${t.txn_id}: ${error.stack || error.message}`); counts.failed++; }
            }
          }
          const ok = counts.sent + counts.logged;
          return go(back, problems.length || counts.failed ? 'error' : 'ok', `${ok} of ${picked.length} reminders sent${counts.logged ? ' (recorded only — email isn’t set up yet in Settings → Email)' : ''}.`
            + (counts.failed ? ` ${counts.failed} failed.` : '') + (problems.length ? ` ${[...new Set(problems)].join(' ')}` : ''));
        }
        if (form.get('action') === 'delete' && form.get('confirmed') !== '1') {
          return page(confirmBatchDeletePage({ ...base(), customer, txns: picked, ids }));
        }
        if (form.get('action') === 'delete') {
          let done = 0; const problems = [];
          for (const t of picked) {
            try { await deleteTxn(pool, { ...scope, txnId: t.txn_id, actor }); done++; } catch (error) {
              if (!(error instanceof ValidationError)) throw error;
              problems.push(`${txnName(t)}: ${error.message}`);
            }
          }
          return go(back, problems.length ? 'error' : 'ok', `${done} of ${picked.length} deleted.${problems.length ? ` ${problems.join(' ')}` : ''}`);
        }
        if (form.get('action') === 'convert') {
          const ests = picked.filter(t => t.type === 'estimate' && !t.voided_at);
          if (ests.length !== 1) return go(back, 'error', 'Choose one estimate to convert to an invoice.');
          return go(`/txns/${ests[0].txn_id}/invoice`);
        }
        if (form.get('action') === 'send') {
          const counts = { sent: 0, logged: 0, failed: 0 }, problems = [];
          const ready = await attempt(back, companyMailer);
          if (!ready.ok) return;
          for (const txnId of ids) {
            // One failure (mail server, PDF) is counted and the rest still go: some emails may already be out.
            try { counts[await sendTransaction(pool, ready.value, { ...scope, txnId, actor, origin: appOrigin() })]++; } catch (error) {
              if (error instanceof ValidationError) problems.push(error.message);
              else { console.error(`batch send txn ${txnId}: ${error.stack || error.message}`); counts.failed++; }
            }
          }
          const ok = counts.sent + counts.logged;
          const text = `${ok} of ${ids.length} sent${counts.logged ? ' (recorded only — email isn’t set up yet in Settings → Email)' : ''}.` +
            (counts.failed ? ` ${counts.failed} failed.` : '') + (problems.length ? ` ${[...new Set(problems)].join(' ')}` : '');
          return go(back, problems.length || counts.failed ? 'error' : 'ok', text);
        }
        throw new HttpError(404, 'Not found');
      }
      if (m[2] === '/export.xlsx' && req.method === 'GET') {
        const filters = parseTxnFilters(query, ctx.today);
        const { rows } = await listTransactions(pool, { orgId: ctx.orgId, customerId: id, filters, today: ctx.today, pageSize: 0 });
        return send(res, 200, await transactionsWorkbook({ customerName: customer.display_name, rows, today: ctx.today }), {
          ...extra,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${exportFilename(customer.display_name)}"`,
        });
      }
      if (!m[2] && req.method === 'GET') {
        return showCustomer(customer, { tab: TABS.some(([k]) => k === query.tab) ? query.tab : 'transactions' });
      }
      if (m[2] === '/statements' && req.method === 'POST') {
        const get = k => (form.get(k) ?? '').trim();
        const f = { kind: get('kind'), statementDate: get('statementDate'), startDate: get('startDate'), endDate: get('endDate') };
        const action = form.get('action');
        try {
          if (action === 'preview') return pdf(res, await statementPreviewPdf(pool, { ...scope, customerId: id, request: f }), 'statement-preview.pdf');
          const statementId = await createStatement(pool, { ...scope, customerId: id, request: f, actor });
          const back = `/customers/${id}?tab=statements`;
          if (action !== 'send') return go(back, 'ok', 'Statement saved.');
          const status = await sendStatement(pool, await companyMailer(), { ...scope, statementId, actor });
          return go(back, status === 'failed' ? 'error' : 'ok', sentText('Statement', status));
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return showCustomer(customer, { tab: 'statements', forms: { statement: { ...f, error: error.message } }, status: 422 });
        }
      }
      if (m[2] === '/recurring/new' && req.method === 'GET') {
        // Row ▾ → Make recurring: start the template from that invoice or sales receipt.
        let v = newTemplateValues(ctx.today);
        const fromId = idParam(query.from);
        if (fromId) {
          const t = await loadTxn(fromId);
          if (t.customer_id !== id || !['invoice', 'sales_receipt'].includes(t.type)) throw new HttpError(404, 'Transaction not found');
          const sv = salesValuesFromTxn(t, { copy: true, today: ctx.today });
          v = { ...v, name: `${TYPE_LABELS[t.type]} ${t.doc_number ?? ''}`.trim(), txnType: t.type, termsId: t.terms_id ? String(t.terms_id) : '', memo: sv.memo,
            lines: sv.lines.map(l => ({ itemId: l.itemId, description: l.description, quantity: l.quantity, rate: l.rate })) };
        }
        return page(templateForm({ ...base(), customer, items: await listItems(pool, scope), terms: await listTerms(pool, scope), v }));
      }
      if (m[2] === '/recurring' && req.method === 'POST') {
        const v = templateFormValues(form);
        try {
          await saveTemplate(pool, { ...scope, customerId: id, fields: { ...v, isNew: true }, today: ctx.today, actor });
          return go(`/customers/${id}?tab=recurring`, 'ok', `Recurring template “${v.name.trim()}” created.`);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return page(templateForm({ ...base(), customer, items: await listItems(pool, scope), terms: await listTerms(pool, scope), v, error: error.message }), 422);
        }
      }
      if (m[2] === '/projects' && req.method === 'POST') {
        const v = projectFormValues(form);
        try {
          const projectId = await saveProject(pool, { ...scope, customerId: id, fields: { ...v, isNew: true }, actor });
          return go(`/projects/${projectId}`, 'ok', `Project “${v.name.trim()}” created.`);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return showCustomer(customer, { tab: 'projects', forms: { project: { v, error: error.message } }, status: 422 });
        }
      }
      if (m[2] === '/documents' && req.method === 'POST') {
        try {
          await addDocument(pool, { ...scope, customerId: id, txnId: idParam(form.get('txn_id')), file: files.find(f => f.field === 'file'), note: form.get('note'), actor });
          return go(`/customers/${id}?tab=documents`, 'ok', 'Document added.');
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return showCustomer(customer, { tab: 'documents', forms: { uploadError: error.message }, status: 422 });
        }
      }
      if (m[2] === '/late-fees' && req.method === 'POST') {
        const enabled = form.get('enabled') === '1';
        await setCustomerLateFees(pool, { ...scope, customerId: id, enabled, actor });
        return go(`/customers/${id}?tab=late-fees`, 'ok', `Late fees turned ${enabled ? 'on' : 'off'} for ${customer.display_name}.`);
      }
      if (m[2] === '/messages' && req.method === 'POST') {
        const v = { to: form.get('to') ?? '', from: form.get('from') ?? '', subject: form.get('subject') ?? '', body: form.get('body') ?? '' };
        const back = `/customers/${id}?tab=conversations`;
        if (form.get('action') === 'reply') {
          try {
            await logReply(pool, { ...scope, customerId: id, from: v.from, subject: v.subject, body: v.body, actor });
            return go(back, 'ok', 'Reply saved to the conversation.');
          } catch (error) {
            if (!(error instanceof ValidationError)) throw error;
            return showCustomer(customer, { tab: 'conversations', forms: { reply: { ...v, open: true, error: error.message } }, status: 422 });
          }
        }
        try {
          const status = await sendCustomerEmail(pool, await companyMailer(), { ...scope, customerId: id, to: v.to, subject: v.subject, body: v.body, actor });
          return go(back, status === 'failed' ? 'error' : 'ok', sentText('Email', status));
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return showCustomer(customer, { tab: 'conversations', forms: { compose: { ...v, open: true, error: error.message } }, status: 422 });
        }
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- settings ----
    if (path === '/settings' && req.method === 'GET') return page(settingsIndexPage({ ...base(), flash: takeFlash() }));
    if (path === '/settings/email') {
      const settings = await getEmailSettings(pool, scope);
      const emailPage = (v, more = {}, status = 200) =>
        page(emailSettingsPage({ ...base(), timeZone: ctx.timeZone, hasKey: Boolean(settingsKey(env)), settings, v, ...more }), status);
      if (req.method === 'GET') return emailPage(emailToValues(settings), { flash: takeFlash() });
      const v = emailFormValues(form);
      try {
        await saveEmailSettings(pool, { ...scope, fields: v, env });
        return go('/settings/email', 'ok', v.mode === 'smtp' ? 'Email settings saved. Send a test email to make sure they work.' : 'Email settings saved. Sends are recorded only.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return emailPage({ ...v, password: '' }, { error: error.message }, 422);
      }
    }
    if (path === '/settings/email/test' && req.method === 'POST') {
      const back = '/settings/email';
      const to = (form.get('to') ?? '').trim();
      if (!EMAIL.test(to)) return go(back, 'error', 'Enter the address to send the test to.');
      const ready = await attempt(back, companyMailer);
      if (!ready.ok) return;
      if (ready.value.kind !== 'smtp') return go(back, 'error', 'Choose “Send from my email account” and save before testing.');
      try {
        await ready.value.send({ to, subject: `Test email from ${ctx.entityName}`,
          text: `This is a test from Financial Books.\n\nIf you can read this, ${ctx.entityName}'s invoices and statements will be emailed from ${ready.value.from}.` });
        await recordEmailTest(pool, { ...scope, ok: true });
        return go(back, 'ok', `Test email sent to ${to}. Check that inbox (and spam) to be sure it arrived.`);
      } catch (error) {
        await recordEmailTest(pool, { ...scope, ok: false, error: error.message });
        return go(back, 'error', `The test email failed: ${error.message}`);
      }
    }

    // ---- recurring templates ----
    m = /^\/recurring\/(\d{1,18})(\/edit|\/pause|\/resume|\/delete)?$/.exec(path);
    if (m) {
      const t = await getTemplate(pool, { ...scope, templateId: Number(m[1]) });
      if (!t) throw new HttpError(404, 'Template not found');
      const customer = await loadCustomer(t.customer_id);
      const back = `/customers/${t.customer_id}?tab=recurring`;
      const formPage = async (v, error = null, status = 200) => page(templateForm({ ...base(), customer, templateId: t.template_id,
        items: await listItems(pool, scope), terms: await listTerms(pool, scope), v, error }), status);
      if (m[2] === '/edit' && req.method === 'GET') return formPage(templateToValues(t, templateLineRows(t)));
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (!m[2]) {
        const v = templateFormValues(form);
        try {
          await saveTemplate(pool, { ...scope, customerId: t.customer_id, templateId: t.template_id, fields: v, today: ctx.today, actor });
          return go(back, 'ok', `Recurring template “${v.name.trim()}” saved.`);
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          return formPage(v, error.message, 422);
        }
      }
      if (m[2] === '/pause' || m[2] === '/resume') {
        await setTemplateActive(pool, { ...scope, templateId: t.template_id, active: m[2] === '/resume', today: ctx.today, actor });
        return go(back, 'ok', `“${t.name}” ${m[2] === '/resume' ? 'resumed' : 'paused'}.`);
      }
      await deleteTemplate(pool, { ...scope, templateId: t.template_id, actor });
      return go(back, 'ok', `“${t.name}” deleted.`);
    }

    // ---- vendors (and, from stage V3, their transactions) ----
    const helpers = { req, res, path, query, form, files, ctx, scope, pool, env, page, base, go, takeFlash, actor, who, identity, canNavigate,
      owner: who.owner ? who : null, breakGlassOwner: auth.configured || auth.devNoAuth ? owner : null,
      send, extra, companyMailer, attempt, ledgerline, aiFetch, smsFetch, saveOpts, saveChoice, appOrigin,
      headersFor, batchMax: demo ? DEMO_BATCH_MAX : 200, reportYears: demo ? DEMO_REPORT_YEARS : null, mgmtSections: demo ? DEMO_MGMT_SECTIONS : null };
    if (await companyRoutes({ ...helpers, session })) return;
    if (await bankFeedRoutes(helpers)) return;
    if (await bankingRoutes(helpers)) return;
    if (await aiRoutes(helpers)) return;
    if (await txnExtrasRoutes(helpers)) return;
    if (await salesExtrasRoutes(helpers)) return;
    if (await receiptRoutes(helpers)) return;
    if (await navRoutes({ ...helpers, navData, url })) return;
    if (await listRoutes(helpers)) return;
    if (await vendorRoutes(helpers)) return;
    // Books may be imported after startup found no organization. Users writes need a trusted actor
    // for the request's resolved organization, retaining the server's owner designation.
    if (await userRoutes({ ...helpers, identity: trustedActor(who, ctx.orgId, session, ownerUserId), session, userRoutesTestHooks })) return;
    if (await ledgerToolsRoutes(helpers)) return;
    if (await loanRoutes(helpers)) return;
    if (await taxRoutes(helpers)) return;
    if (await toolsRoutes(helpers)) return;
    if (await timeRoutes(helpers)) return;
    if (await mgmtRoutes(helpers)) return;
    if (await insightRoutes(helpers)) return;
    if (await reportRoutes(helpers)) return;

    // ---- deposits ----
    if (path === '/deposits' && req.method === 'GET') {
      const [deposits, waiting] = await Promise.all([listDeposits(pool, scope), listUndeposited(pool, scope)]);
      return page(depositsPage({ ...base(), flash: takeFlash(), deposits, waiting }));
    }
    if ((path === '/deposits/new' && req.method === 'GET') || (path === '/deposits' && req.method === 'POST')) {
      const showDepositForm = async (v, error = null, status = 200) => {
        const [waiting, banks, all, customers] = await Promise.all([listUndeposited(pool, scope), accountsOfTypes(pool, { ...scope, types: ['bank'] }),
          listAccounts(pool, { ...scope, includeInactive: false }), allCustomers()]);
        const otherAccounts = all.filter(a => !['undeposited', 'ar', 'ap'].includes(a.system_key));
        return page(depositForm({ ...base(), save: await saveOpts('deposit'), waiting, banks, otherAccounts, customers, v, error }), status);
      };
      if (req.method === 'GET') return showDepositForm({ accountId: '', txnDate: ctx.today, memo: '', selected: [], other: [], cashBack: {} });
      const v = depositFormValues(form);
      try {
        const txnId = await saveDeposit(pool, { ...scope, actor, accountId: idParam(v.accountId), txnDate: v.txnDate, memo: v.memo,
          sourceTxnIds: v.selected.map(idParam).filter(Boolean), otherLines: v.other, cashBack: v.cashBack });
        const choice = await saveChoice('deposit');
        // Stage F1: save and new → a blank deposit; save and close → back where it came from (else the deposit);
        // stage F5: save and print → the deposit slip and summary.
        if (choice === 'new') return go('/deposits/new', 'ok', 'Deposit saved.');
        if (choice === 'print') return go(`/deposits/${txnId}/slip.pdf`);
        return go(safeBack(form.get('back')) ?? `/deposits/${txnId}`, 'ok', 'Deposit saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return showDepositForm(v, error.message, 422);
      }
    }
    m = /^\/deposits\/(\d{1,18})(\/delete|\/slip\.pdf)?$/.exec(path);
    if (m) {
      const deposit = await getDeposit(pool, { ...scope, txnId: Number(m[1]) });
      if (!deposit) throw new HttpError(404, 'Deposit not found');
      if (isImported(deposit) && m[2] === '/delete') return go(`/deposits/${deposit.txn_id}`, 'error', IMPORTED_LOCKED);
      if (m[2] === '/slip.pdf') {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        return pdf(res, await renderDepositSlipPdf({ entity: await getEntity(pool, scope), deposit, summaryOnly: query.summary === '1' }), `deposit-${deposit.txn_date}.pdf`);
      }
      const reconciled = (await pool.query('SELECT 1 FROM reconciled_item WHERE txn_id = $1 LIMIT 1', [deposit.txn_id])).rowCount > 0;
      if (req.method === 'GET' && !m[2]) return page(depositPage({ ...base(), flash: takeFlash(), deposit, reconciled }));
      if (req.method === 'POST' && m[2]) {
        // A reconciled deposit is locked; an admin can still delete it by confirming (as for every other locked transaction).
        if (!(await attempt(`/deposits/${deposit.txn_id}`, () => deleteDeposit(pool, { ...scope, txnId: deposit.txn_id, actor, override: overrideOk() }))).ok) return;
        return go('/deposits', 'ok', `Deposit of ${formatCents(deposit.total_cents)} deleted; its payments are back in Undeposited Funds.`);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- projects ----
    m = /^\/projects\/(\d{1,18})(\/delete)?$/.exec(path);
    if (m) {
      const p = await getProject(pool, { ...scope, projectId: Number(m[1]) });
      if (!p) throw new HttpError(404, 'Project not found');
      const show = async (extraProps = {}, status = 200) => page(projectPage({ ...base(), flash: takeFlash(), project: p, today: ctx.today,
        txns: await listProjectTransactions(pool, { orgId: ctx.orgId, projectId: p.project_id }),
        costs: await projectCosts(pool, { orgId: ctx.orgId, projectId: p.project_id }), ...extraProps }), status);
      if (req.method === 'GET' && !m[2]) return show();
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (m[2]) {
        if (!(await attempt(`/projects/${p.project_id}`, () => deleteProject(pool, { ...scope, projectId: p.project_id, actor }))).ok) return;
        return go(`/customers/${p.customer_id}?tab=projects`, 'ok', `Project “${p.name}” deleted.`);
      }
      const v = projectFormValues(form);
      try {
        await saveProject(pool, { ...scope, customerId: p.customer_id, projectId: p.project_id, fields: v, actor });
        return go(`/projects/${p.project_id}`, 'ok', 'Project saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return show({ v, error: error.message }, 422);
      }
    }

    // ---- documents ----
    m = /^\/documents\/(\d{1,18})(\/delete)?$/.exec(path);
    if (m) {
      const d = await getDocument(pool, { ...scope, documentId: Number(m[1]), withContent: req.method === 'GET' && !m[2] });
      // A customers-only person can't open vendor documents (W-9s…), and the other way round.
      if (!d || !canAccess(who.role, 'GET', d.vendor_id ? '/vendors' : '/customers')) throw new HttpError(404, 'Document not found');
      if (req.method === 'GET' && !m[2]) {
        return send(res, 200, d.content, { ...extra, 'Content-Type': downloadType(d.filename), 'Content-Disposition': attachmentHeader(d.filename),
          'Content-Security-Policy': "default-src 'none'; sandbox" });
      }
      if (req.method === 'POST' && m[2]) {
        await deleteDocument(pool, { ...scope, documentId: d.document_id, actor });
        return go(d.vendor_id ? `/vendors/${d.vendor_id}?tab=documents` : `/customers/${d.customer_id}?tab=documents`, 'ok', `“${d.filename}” deleted.`);
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- statements ----
    m = /^\/statements\/(\d{1,18})(\.pdf|\/send)$/.exec(path);
    if (m) {
      const st = await getStatement(pool, { ...scope, statementId: Number(m[1]) });
      if (!st) throw new HttpError(404, 'Statement not found');
      if (m[2] === '.pdf' && req.method === 'GET') return pdf(res, await statementPdf(pool, { ...scope, statement: st }), statementFilename(st));
      if (m[2] === '/send' && req.method === 'POST') {
        const back = `/customers/${st.customer_id}?tab=statements`;
        const result = await attempt(back, async () => sendStatement(pool, await companyMailer(), { ...scope, statementId: st.statement_id, actor }));
        if (!result.ok) return;
        return go(back, result.value === 'failed' ? 'error' : 'ok', sentText('Statement', result.value));
      }
      throw new HttpError(405, 'Method not allowed');
    }

    // ---- settings: terms, products and services, late fees ----
    const settingsPage = (tab, body, status = 200, flash = takeFlash()) => page(settingsLayout({ ...base(), flash, tab, body }), status);
    if (await salesSettingsRoutes({ ...helpers, settingsPage })) return;
    if (await accountingRoutes({ ...helpers, settingsPage })) return;
    if (await paymentsSettingsRoutes({ ...helpers, settingsPage })) return;
    if (await currencyRoutes({ ...helpers, settingsPage })) return;
    if (path === '/settings/terms' && req.method === 'GET') return settingsPage('terms', termsSettingsBody({ csrf: session.csrf, terms: await listTermsWithUse(pool, scope) }));
    m = /^\/settings\/terms(?:\/(\d{1,18}))?(\/delete)?$/.exec(path);
    if (m && req.method === 'POST') {
      const termsId = m[1] ? Number(m[1]) : null;
      try {
        if (m[2]) return go('/settings/terms', 'ok', `“${await deleteTerms(pool, { ...scope, termsId })}” deleted.`);
        await saveTerms(pool, { ...scope, termsId, name: form.get('name'), dueDays: form.get('dueDays') });
        return go('/settings/terms', 'ok', 'Terms saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return settingsPage('terms', termsSettingsBody({ csrf: session.csrf, terms: await listTermsWithUse(pool, scope), error: error.message }), 422, null);
      }
    }
    if (path === '/settings/items' && req.method === 'GET') return settingsPage('items', itemsSettingsBody({ items: await listAllItems(pool, scope) }));
    if (path === '/settings/items/new' && req.method === 'GET') {
      return settingsPage('items', itemFormBody({ csrf: session.csrf, incomeAccounts: await accountsOfTypes(pool, { ...scope, types: ['income', 'other_income'] }),
        expenseAccounts: await accountsOfTypes(pool, { ...scope, types: ['cost_of_goods_sold', 'expense', 'other_expense'] }),
        assetAccounts: (await accountsOfTypes(pool, { ...scope, types: ['inventory', 'other_current_asset'] })).filter(a => a.system_key !== 'undeposited'),
        v: { name: '', description: '', kind: 'inventory', rate: '', active: true, incomeAccountId: '', expenseAccountId: '', cost: '', sku: '', reorderPoint: '',
          assetAccountId: '', startQty: '', asOf: ctx.today } }));
    }
    m = /^\/settings\/items\/(\d{1,18})\/adjust$/.exec(path);
    if (m) {
      const item = await getItem(pool, { ...scope, itemId: Number(m[1]) });
      if (!item || item.kind !== 'inventory') throw new HttpError(404, 'Inventory item not found');
      const accounts = await accountsOfTypes(pool, { ...scope, types: ['cost_of_goods_sold', 'expense', 'other_expense', 'equity'] });
      const shrink = accounts.find(a => a.system_key === 'shrinkage');
      const show = (v, error = null, status = 200) => settingsPage('items', adjustQuantityBody({ csrf: session.csrf, item, accounts, v, error }), status, null);
      if (req.method === 'GET') return show({ txnDate: ctx.today, newQty: '', accountId: String(shrink?.account_id ?? ''), memo: '' });
      const v = { txnDate: String(form.get('txn_date') ?? ''), newQty: String(form.get('newQty') ?? ''), accountId: String(form.get('accountId') ?? ''), memo: String(form.get('memo') ?? '') };
      try {
        const qtyText = v.newQty.trim();
        const newQty = /^-?\d{1,7}(\.\d{1,4})?$/.test(qtyText) ? scaledQty(qtyText) : null;
        if (newQty === null) throw new ValidationError('Enter the quantity you counted, like 37.');
        const r = await adjustQuantity(pool, { ...scope, itemId: item.item_id, txnDate: v.txnDate, newQty, accountId: idParam(v.accountId), memo: v.memo, actor });
        return go(`/settings/items/${item.item_id}`, 'ok', `Quantity adjusted; ${formatCents(Math.abs(r.costCents))} ${r.costCents < 0 ? 'written off' : 'added'}.`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return show(v, error.message, 422);
      }
    }
    m = /^\/settings\/items(?:\/(\d{1,18}))?$/.exec(path);
    if (m) {
      const itemId = m[1] ? Number(m[1]) : null;
      const existing = itemId ? await getItem(pool, { ...scope, itemId }) : null;
      if (itemId && !existing) throw new HttpError(404, 'Product or service not found');
      const incomeAccounts = await accountsOfTypes(pool, { ...scope, types: ['income', 'other_income'] });
      const expenseAccounts = await accountsOfTypes(pool, { ...scope, types: ['cost_of_goods_sold', 'expense', 'other_expense'] });
      const assetAccounts = (await accountsOfTypes(pool, { ...scope, types: ['inventory', 'other_current_asset'] })).filter(a => a.system_key !== 'undeposited');
      const history = existing?.kind === 'inventory' ? await itemHistory(pool, { orgId: ctx.orgId, itemId }) : [];
      const lists = { csrf: session.csrf, itemId, incomeAccounts, expenseAccounts, assetAccounts, item: existing, history };
      if (req.method === 'GET') return settingsPage('items', itemFormBody({ ...lists, v: itemToValues(existing) }));
      const v = itemFormValues(form);
      try {
        await saveItem(pool, { ...scope, itemId, fields: v, actor });
        return go('/settings/items', 'ok', `“${v.name.trim()}” saved.`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return settingsPage('items', itemFormBody({ ...lists, v, error: error.message }), 422, null);
      }
    }
    // ---- settings: chart of accounts ----
    if (path === '/settings/accounts' && req.method === 'GET') {
      const [accounts, check] = await Promise.all([listAccounts(pool, scope), ledgerCheck(pool, scope)]);
      return settingsPage('accounts', chartOfAccountsBody({ accounts, check, showInactive: query.inactive === '1' }));
    }
    m = /^\/settings\/accounts(?:\/(new|\d{1,18}))?(\/edit|\/delete)?$/.exec(path);
    if (m) {
      const accountId = m[1] && m[1] !== 'new' ? Number(m[1]) : null;
      const account = accountId ? await getAccount(pool, { ...scope, accountId }) : null;
      if (accountId && !account) throw new HttpError(404, 'Account not found');
      const parentsFor = async () => (await listAccounts(pool, scope)).filter(a => !a.parent_id && !a.system_key && a.active);
      const showForm = async (v, error = null, status = 200) =>
        settingsPage('accounts', accountFormBody({ csrf: session.csrf, account, parents: await parentsFor(), v, error }), status, error ? null : takeFlash());
      if (req.method === 'GET') {
        if (m[1] === 'new' && !m[2]) return showForm({ ...NEW_ACCOUNT, type: ['bank', 'income', 'expense'].includes(query.type) ? query.type : 'expense' });
        if (account && m[2] === '/edit') return showForm(accountToValues(account));
        if (account && !m[2]) {
          return settingsPage('accounts', registerBody({ account, rows: await accountRegister(pool, { orgId: ctx.orgId, accountId, type: account.type }) }));
        }
        throw new HttpError(404, 'Not found');
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      if (account && m[2] === '/delete') {
        if (!(await attempt(`/settings/accounts/${accountId}/edit`, () => deleteAccount(pool, { ...scope, accountId }))).ok) return;
        return go('/settings/accounts', 'ok', `“${account.name}” deleted.`);
      }
      if (m[1] === 'new' || (account && m[2] !== '/edit') || (!account && m[2])) throw new HttpError(404, 'Not found');
      const v = accountFormValues(form);
      try {
        const id = await saveAccount(pool, { ...scope, accountId, fields: v });
        return go(`/settings/accounts/${id}`, 'ok', `“${v.name.trim()}” saved.`);
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return showForm(v, error.message, 422);
      }
    }

    if (path === '/settings/bills') {
      const current = await getBillSettings(pool, scope);
      const show = (v, error = null, status = 200) => settingsPage('bills', billSettingsBody({ csrf: session.csrf, v, error }), status, error ? null : takeFlash());
      if (req.method === 'GET') return show({ requireApproval: current.require_approval, nextCheckNumber: String(current.next_check_number) });
      const v = { requireApproval: form.get('requireApproval') === '1', nextCheckNumber: String(form.get('nextCheckNumber') ?? '') };
      try {
        await saveBillSettings(pool, { ...scope, ...v });
        return go('/settings/bills', 'ok', 'Bill settings saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return show(v, error.message, 422);
      }
    }

    if (path === '/settings/late-fees') {
      const policy = await getPolicy(pool, scope);
      if (req.method === 'GET') return settingsPage('late-fees', lateFeeSettingsBody({ csrf: session.csrf, policy, v: policyToValues(policy) }));
      const v = policyFormValues(form);
      try {
        await savePolicy(pool, { ...scope, fields: v, today: ctx.today });
        return go('/settings/late-fees', 'ok', 'Late fee settings saved.');
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        return settingsPage('late-fees', lateFeeSettingsBody({ csrf: session.csrf, policy, v, error: error.message }), 422, null);
      }
    }

    // ---- transactions ----
    if (path === '/txns/new' && req.method === 'GET') {
      if (query.template) {
        const t = await getTemplate(pool, { ...scope, templateId: idParam(query.template) ?? 0 });
        // Only a customer's invoice or sales receipt template opens here (a vendor's bill template is on the vendor side).
        if (!t || !t.customer_id || !['invoice', 'sales_receipt'].includes(t.txn_type)) throw new HttpError(404, 'Template not found');
        return renderEditor({ type: t.txn_type, v: { customerId: String(t.customer_id), txnDate: ctx.today, dueDate: '', termsId: t.terms_id ? String(t.terms_id) : '',
          docNumber: '', memo: t.memo ?? '', paymentMethod: '', paymentRef: '', lines: templateLineRows(t) } });
      }
      if (query.copy) {
        const src = await loadTxn(idParam(query.copy));
        if (!SALES_TYPES.includes(src.type)) throw new HttpError(404, 'Only invoices, sales receipts, and credit memos can be copied');
        return renderEditor({ type: src.type, v: salesValuesFromTxn(src, { copy: true, today: ctx.today }) });
      }
      const type = NEW_TYPES.includes(query.type) ? query.type : 'invoice';
      const customerId = idParam(query.customer);
      if (customerId) await loadCustomer(customerId);
      const projectId = customerId && idParam(query.project) ? String(idParam(query.project)) : '';
      if (type === 'invoice' && customerId && query.billable === '1') {
        const expenses = await unbilledExpenses(pool, { ...scope, customerId });
        const acct = await getAccountingSettings(pool, scope);
        return renderEditor({ type, v: { customerId: String(customerId), txnDate: ctx.today, dueDate: '', termsId: '', docNumber: '', memo: '', paymentMethod: '',
          paymentRef: '', projectId, lines: [...billableLines(acct.billableOn ? expenses : [], acct), ...timeLines(await unbilledTime(pool, { ...scope, customerId }))] } });
      }
      if (type === 'payment') {
        const v = { customerId: customerId ? String(customerId) : '', txnDate: ctx.today, paymentMethod: '', paymentRef: '', amount: '', memo: '', apply: {} };
        const chargeId = idParam(query.charge);
        if (customerId && chargeId) {
          const charge = (await listOpenCharges(pool, { orgId: ctx.orgId, customerId })).find(c => c.txn_id === chargeId);
          if (charge) { v.apply[chargeId] = centsToInput(charge.open_cents); v.amount = centsToInput(charge.open_cents); }
        }
        return renderEditor({ type, v });
      }
      return renderEditor({ type, v: { customerId: customerId ? String(customerId) : '', txnDate: ctx.today, dueDate: '', termsId: '', docNumber: '', memo: '', paymentMethod: '', paymentRef: '', projectId, lines: [] } });
    }
    if (path === '/txns' && req.method === 'POST') {
      const type = NEW_TYPES.includes(form.get('type')) ? form.get('type') : null;
      if (!type) throw new HttpError(400, 'Unknown transaction type');
      const txnId = await saveEditor({ type });
      if (txnId === null) return;
      return afterSalesSave(await loadTxn(txnId), await saveChoice(type));
    }
    // Where a saved sales form goes: close → back where it was opened from (else the customer); new → a blank form of the same
    // type; save → stays open on the saved transaction; send → emailed, then close; print → its PDF.
    async function afterSalesSave(t, choice) {
      const closeTo = safeBack(form.get('back')) ?? `/customers/${t.customer_id}`;
      const saved = `${txnName(t)} saved.${await overLimit(t)}`;
      if (choice === 'print') return go(`/txns/${t.txn_id}.pdf`);
      if (choice === 'new') return go(`/txns/new?type=${t.type}`, 'ok', saved);
      if (choice === 'save') return go(t.type === 'payment' ? `/txns/${t.txn_id}` : `/txns/${t.txn_id}/edit`, 'ok', saved);
      if (choice === 'send') {
        const sent = await attempt(`/txns/${t.txn_id}`, async () => sendTransaction(pool, await companyMailer(), { ...scope, actor, txnId: t.txn_id, origin: appOrigin() }));
        if (!sent.ok) return;
        return go(closeTo, sent.value === 'failed' ? 'error' : 'ok', `${txnName(t)} saved. ${sentText(txnName(t), sent.value)}`);
      }
      return go(closeTo, 'ok', saved);
    }

    m = /^\/txns\/(\d{1,18})(\.pdf|\/edit|\/void|\/delete|\/send|\/apply|\/status|\/invoice|\/reminder|\/packing-slip\.pdf|\/share)?$/.exec(path);
    if (m) {
      const t = await loadTxn(Number(m[1]));
      const view = `/txns/${t.txn_id}`;
      const action = m[2] ?? '';
      // Imported QuickBooks history: viewed, printed, sent and paid, never changed.
      if (isImported(t) && (['/edit', '/void', '/delete', '/status'].includes(action) || (action === '' && req.method === 'POST'))) return go(view, 'error', IMPORTED_LOCKED);
      if (action === '/packing-slip.pdf' && req.method === 'GET') {
        if (!['invoice', 'sales_receipt', 'estimate'].includes(t.type)) throw new HttpError(404, 'Not found');
        return pdf(res, await transactionsPdf(pool, { ...scope, txnIds: [t.txn_id], packingSlip: true }), `packing-slip-${(t.doc_number ?? t.txn_id).toString().replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`);
      }
      if (action === '/reminder' && req.method === 'POST') {
        const back = `/customers/${t.customer_id}`;
        const ready = await attempt(back, companyMailer);
        if (!ready.ok) return;
        const r = await attempt(back, () => sendReminderNow(pool, ready.value, { ...scope, txnId: t.txn_id, actor }));
        if (!r.ok) return;
        return go(back, r.value === 'failed' ? 'error' : 'ok', sentText(`Reminder for ${txnName(t)}`, r.value));
      }
      // Share invoice link: a one-time pay link to copy (online payments must be on).
      if (action === '/share' && req.method === 'POST') {
        const token = await createPayLink(pool, { ...scope, txnId: t.txn_id });
        if (!token) return go(`/customers/${t.customer_id}`, 'error', ['invoice', 'late_fee'].includes(t.type) && t.open_cents > 0
          ? 'Turn on online payments (Settings → Payments) to share a pay link.' : 'Only an open invoice has a pay link.');
        return page(shareLinkPage({ ...base(), txn: t, link: `${appOrigin()}/pay/${token}` }));
      }
      if (req.method === 'GET' && action === '') {
        const charges = (t.type === 'payment' || t.type === 'credit_memo') && !t.voided_at && t.open_cents > 0
          ? await listOpenCharges(pool, { orgId: ctx.orgId, customerId: t.customer_id }) : [];
        const documents = await listTxnDocuments(pool, { orgId: ctx.orgId, txnId: t.txn_id });
        return page(txnPage({ ...base(), flash: takeFlash(), txn: t, today: ctx.today, charges, documents }));
      }
      if (req.method === 'GET' && action === '.pdf') {
        return pdf(res, await transactionsPdf(pool, { ...scope, txnIds: [t.txn_id] }), `${(t.doc_number ?? t.payment_ref ?? `txn-${t.txn_id}`).replace(/[^A-Za-z0-9-]+/g, '-')}.pdf`);
      }
      if (req.method === 'GET' && action === '/invoice') {
        if (t.type !== 'estimate') throw new HttpError(404, 'Not found');
        const r = await attempt(view, () => invoiceFromEstimate(pool, { orgId: ctx.orgId, estimate: t, mode: query.mode, percent: query.percent, today: ctx.today }));
        if (!r.ok) return;
        return renderEditor({ type: 'invoice', v: r.value });
      }
      if (action === '/status' && req.method === 'POST') {
        if (!(await attempt(view, () => setEstimateStatus(pool, { ...scope, txnId: t.txn_id, status: form.get('status'), actor }))).ok) return;
        return go(view, 'ok', 'Estimate updated.');
      }
      if (req.method === 'GET' && action === '/edit') {
        if (t.voided_at || t.type === 'late_fee') return go(view, 'error', t.voided_at ? 'Voided transactions can’t be edited.' : 'Late fees can’t be edited here.');
        if (t.system_kind === 'opening_balance') return go(view, 'error', 'An opening balance can’t be edited as an invoice. Delete it and enter the balance again, or use a journal entry.');
        if (t.type === 'payment') {
          const charges = await listOpenCharges(pool, { orgId: ctx.orgId, customerId: t.customer_id, paymentTxnId: t.txn_id });
          const apply = Object.fromEntries(charges.filter(c => c.applied_cents > 0).map(c => [c.txn_id, centsToInput(c.applied_cents)]));
          return renderEditor({ type: 'payment', txnId: t.txn_id, v: { customerId: String(t.customer_id), txnDate: t.txn_date, paymentMethod: t.payment_method ?? '',
            paymentRef: t.payment_ref ?? '', amount: centsToInput(t.currency ? t.foreign_total_cents : t.total_cents), memo: t.memo ?? '', apply, depositToId: t.account_id ? String(t.account_id) : '',
            exchangeRate: t.currency ? String(Number(t.exchange_rate)) : '' } });
        }
        return renderEditor({ type: t.type, txnId: t.txn_id, v: salesValuesFromTxn(t) });
      }
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const back = `/customers/${t.customer_id}`;
      if (action === '') {
        if (t.type === 'late_fee') throw new HttpError(400, 'Late fees can’t be edited here');
        const id = await saveEditor({ type: t.type, txnId: t.txn_id });
        if (id === null) return;
        return afterSalesSave(await loadTxn(id), await saveChoice(t.type));
      }
      if (action === '/void') {
        if (!(await attempt(view, () => voidTxn(pool, { ...scope, actor, txnId: t.txn_id, override: overrideOk() }))).ok) return;
        return go(back, 'ok', `${txnName(t)} voided.`);
      }
      if (action === '/delete') {
        if (!(await attempt(view, () => deleteTxn(pool, { ...scope, actor, txnId: t.txn_id, override: overrideOk() }))).ok) return;
        return go(back, 'ok', `${txnName(t)} deleted.`);
      }
      if (action === '/send') {
        const result = await attempt(view, async () => sendTransaction(pool, await companyMailer(), { ...scope, actor, txnId: t.txn_id, origin: appOrigin() }));
        if (!result.ok) return;
        return go(view, result.value === 'failed' ? 'error' : 'ok', sentText(txnName(t), result.value));
      }
      if (action === '/apply') {
        const v = paymentValuesFromForm(form);
        if (!(await attempt(view, () => applyCredit(pool, { ...scope, actor, creditTxnId: t.txn_id, applications: parseApplications(v.apply), appliedOn: ctx.today }))).ok) return;
        return go(view, 'ok', 'Applied.');
      }
    }

    throw new HttpError(404, 'Not found');
  }

  const handler = async function handler(req, res) {
    try {
      await withActor(() => withDisplay(() => routes(req, res)));
    } catch (error) {
      req.demoSlotDone?.();
      if (error instanceof MorningAccessError && ['stale_session','foreign_org'].includes(error.reason) && req.method === 'GET') {
        const { session } = auth.current(req);
        return redirect(res, `/login?next=${encodeURIComponent(req.url)}`, session ? { 'Set-Cookie': auth.end(session) } : {});
      }
      const locked = error?.code === 'P0001' && /^Imported from QuickBooks/.test(error.message ?? '');
      const connectionFailure = /^08|^ECONN|^EPIPE/.test(error?.code ?? '') || error?.code === '57P01'
        || /Query read timeout|Connection terminated|connection error/i.test(error?.message ?? '');
      const unavailable = error instanceof LockBusyError || error instanceof MorningTimeoutError || error.morningConnectionFailure || connectionFailure;
      const status = unavailable ? 503 : error instanceof ProtectedIdentityError ? 403 : error instanceof MorningAccessError
        ? ['stale_session','foreign_org'].includes(error.reason) ? 401 : 403 : error instanceof HttpError ? error.status : locked ? 409 : 500;
      if (status === 500) console.error(`request failed: ${req.method} ${req.url?.split('?')[0]}: ${error.stack || error.message}`);
      if (res.headersSent) { res.end(); return; }
      const title = { 409: 'Imported from QuickBooks', 400: 'Bad request', 401: 'Sign in required', 403: demo ? 'Not in the demo' : 'Not allowed', 404: 'Not found', 405: 'Not allowed', 413: 'Too large', 415: 'Not supported', 429: 'Slow down', 503: 'Not ready' }[status] ?? 'Something went wrong';
      const message = unavailable ? 'This operation is unavailable. Try again.' : status === 500 ? 'The server hit an error. What it was doing may not have finished; check before trying again.' : error.message;
      send(res, status, String(messagePage({ title, message })), unavailable ? { 'Retry-After': '1' } : {});
    }
    req.demoSlotDone?.();
  };
  handler.ready = morningReady;
  return handler;
}

export async function main(env = process.env) {
  ownerUserIdFromEnv(env);
  console.log(`books mode: ${checkBooksMode(env)}`);
  // DEMO_MODE=1: the public demo (lib/domain/demo.js). A typo, or a real server's settings alongside it, stops here.
  let demo;
  try { demo = checkDemoMode(env) === 'demo'; } catch (error) { console.error(error.message); process.exit(1); }
  if (demo) console.log('public demo: no sign-in, the sample books only, nothing sent; reset nightly by npm run demo-reset');
  // Emailed links (invites, password resets, pay links) must use the real address, never the request's Host header.
  if (env.NODE_ENV === 'production' && !/^https:\/\//.test(env.APP_BASE_URL ?? '')) {
    console.error('APP_BASE_URL must be set to the https:// address of the app in production.');
    process.exit(1);
  }
  const pool = createPool(env);
  // A demo only on a database made by demo-reset; normal books never on one (lib/data/demo.js).
  try { await guardDatabase(pool, env); } catch (error) {
    console.error(error.message);
    await pool.end();
    process.exit(1);
  }
  const port = Number(env.PORT || 3000);
  const host = env.HOST || (env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  // Bank feeds read ledgerline (read-only) when LEDGERLINE_URL is set.
  const ledgerline = demo ? null : ledgerlinePool(env);
  if (ledgerline && env.LEDGERLINE_ORG_ID) await assignTenant(pool, { orgSlug: env.APP_ORG || 'sample', llOrgId: env.LEDGERLINE_ORG_ID });
  const morningRuntime = processMorningRuntime;
  let app;
  try {
    app = createApp({ pool, env, ledgerline, morningRuntime });
    await app.ready;
  } catch (error) {
    await Promise.all([pool.end(), ledgerline?.end()]);
    throw error;
  }
  const server = http.createServer(app);
  server.listen(port, host, () => console.log(`financial-books listening on http://${host}:${port}`));
  // Daily jobs (recurring transactions, late fees): shortly after start, then hourly. Every run is
  // idempotent, so hourly just means "within an hour of midnight". RUN_JOBS=0 turns this off.
  if (env.RUN_JOBS !== '0' && !demo) {
    const tick = () => runDailyJobs({ pool, env, morningRuntime, log: console.log }).catch(error => console.error(`jobs failed: ${error.stack || error.message}`));
    setTimeout(tick, 10_000).unref();
    setInterval(tick, 60 * 60 * 1000).unref();
  }
  // Bank feeds: every 15 minutes, pull each linked company whose ledgerline accounts have synced since its last pull
  // (ledgerline syncs about every 3 hours). BANK_PULLS=0 turns this off.
  if (ledgerline && env.BANK_PULLS !== '0') {
    const pull = () => runBankPulls({ pool, ll: ledgerline, log: console.log, key: settingsKey(env), env }).catch(error => console.error(`bank pulls failed: ${error.message}`));
    setTimeout(pull, 20_000).unref();
    setInterval(pull, 15 * 60 * 1000).unref();
  }
  const stop = () => server.close(() => Promise.all([pool.end(), ledgerline?.end()]).then(() => process.exit(0)));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
