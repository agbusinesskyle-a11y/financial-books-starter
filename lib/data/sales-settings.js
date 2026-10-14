import { ValidationError, EMAIL } from './writes.js';

// Settings → Sales (invoice defaults, statements), Messages and reminders, and Form styles. One row per company each;
// a company without a row gets the defaults below.

const fail = message => { throw new ValidationError(message); };
const text = (v, max) => String(v ?? '').trim().slice(0, max) || null;
const on = v => v === true || v === '1' || v === 'on';

// ---- message templates ----

// [kind, label]. Placeholders: {customer} {number} {amount} {balance} {due_date} {company} (and {vendor} on purchase orders).
export const TEMPLATE_KINDS = [
  ['invoice', 'Invoices'], ['sales_receipt', 'Sales receipts'], ['credit_memo', 'Credit memos'], ['payment', 'Payment receipts'],
  ['statement', 'Statements'], ['estimate', 'Estimates'], ['purchase_order', 'Purchase orders'], ['reminder', 'Invoice reminders'],
];
export const PLACEHOLDERS = ['{customer}', '{number}', '{amount}', '{balance}', '{due_date}', '{company}'];

export const DEFAULT_TEMPLATES = {
  invoice: { subject: 'Invoice {number} from {company}', greeting: 'Dear {customer},',
    body: 'Here’s invoice {number} for {amount}.\nThe balance due is {balance}, due {due_date}.\n\nThe details are attached as a PDF.\n\nThank you,\n{company}' },
  sales_receipt: { subject: 'Sales receipt {number} from {company}', greeting: 'Dear {customer},',
    body: 'Here’s your sales receipt {number} for {amount}.\n\nThe details are attached as a PDF.\n\nThank you,\n{company}' },
  credit_memo: { subject: 'Credit memo {number} from {company}', greeting: 'Dear {customer},',
    body: 'Here’s credit memo {number} for {amount}.\n\nThe details are attached as a PDF.\n\nThank you,\n{company}' },
  payment: { subject: 'Payment receipt from {company}', greeting: 'Dear {customer},',
    body: 'Thank you for your payment of {amount}.\n\nThe details are attached as a PDF.\n\nThank you,\n{company}' },
  statement: { subject: 'Statement from {company}', greeting: 'Dear {customer},',
    body: 'Your statement is attached. The balance due is {balance}.\n\nThank you,\n{company}' },
  estimate: { subject: 'Estimate {number} from {company}', greeting: 'Dear {customer},',
    body: 'Here’s estimate {number} for {amount}.\n\nThe details are attached as a PDF. Reply to accept it.\n\nThank you,\n{company}' },
  purchase_order: { subject: 'Purchase order {number} from {company}', greeting: 'Hello {customer},',
    body: 'Please find purchase order {number} for {amount} attached.\n\nThank you,\n{company}' },
  reminder: { subject: 'Reminder: invoice {number} from {company}', greeting: 'Dear {customer},',
    body: 'This is a friendly reminder that invoice {number} has a balance of {balance}, due {due_date}.\n\nThe invoice is attached as a PDF.\n\nThank you,\n{company}' },
};

// Fills placeholders; unknown ones are left as typed.
export function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{(customer|vendor|number|amount|balance|due_date|company)\}/g, (all, key) => values[key] ?? all);
}

// { subject, text } for one email from the company's template (or the default), with the form-style footer added.
export function renderEmail(settings, kind, values, footer = null) {
  const t = { ...DEFAULT_TEMPLATES[kind], ...(settings.templates?.[kind] ?? {}) };
  const parts = [fillTemplate(t.greeting, values), '', fillTemplate(t.body, values)];
  if (footer) parts.push('', '—', footer);
  return { subject: fillTemplate(t.subject, values).replace(/\s+/g, ' ').trim().slice(0, 200), text: parts.join('\n').replace(/^\n+/, '') };
}

// cc / bcc for a customer email: the company's copies, plus the company's own address when "email me a copy" is on.
export function emailCopies(settings, entity) {
  const bcc = [settings.bcc, settings.copyMe ? entity.own_email : null].filter(Boolean).join(', ');
  return { cc: settings.cc || null, bcc: bcc || null };
}

// ---- reading ----

const DEFAULTS = {
  defaultTermsId: null, defaultDelivery: 'none', customNumbers: true, nextInvoiceNumber: null, serviceDate: false, discount: false,
  shipping: false, deposit: false, statementKind: 'balance_forward', statementAging: true, templates: {}, cc: null, bcc: null,
  copyMe: false, remindersOn: false, remindersFrom: null, reminderRules: [],
};

export async function getSalesSettings(db, { orgId, entityId }) {
  const { rows: [r] } = await db.query('SELECT * FROM sales_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  if (!r) return { ...DEFAULTS };
  return {
    defaultTermsId: r.default_terms_id, defaultDelivery: r.default_delivery, customNumbers: r.custom_numbers, nextInvoiceNumber: r.next_invoice_number,
    serviceDate: r.service_date, discount: r.discount, shipping: r.shipping, deposit: r.deposit, statementKind: r.statement_kind,
    statementAging: r.statement_aging, templates: r.templates ?? {}, cc: r.cc, bcc: r.bcc, copyMe: r.copy_me, remindersOn: r.reminders_on,
    remindersFrom: r.reminders_from, reminderRules: r.reminder_rules ?? [],
  };
}

async function upsert(pool, { orgId, entityId }, columns) {
  const names = Object.keys(columns);
  const values = Object.values(columns);
  await pool.query(
    `INSERT INTO sales_settings (org_id, entity_id, ${names.join(', ')}) VALUES ($1, $2, ${names.map((_, i) => `$${i + 3}`).join(', ')})
     ON CONFLICT (org_id, entity_id) DO UPDATE SET ${names.map(n => `${n} = EXCLUDED.${n}`).join(', ')}`,
    [orgId, entityId, ...values]);
}

// ---- Settings → Sales ----

export async function saveSalesSettings(pool, { orgId, entityId, fields: f }) {
  const defaultTermsId = /^\d{1,18}$/.test(String(f.defaultTermsId ?? '')) ? Number(f.defaultTermsId) : null;
  if (defaultTermsId) {
    const t = await pool.query('SELECT 1 FROM terms WHERE org_id = $1 AND terms_id = $2 AND entity_id = $3', [orgId, defaultTermsId, entityId]);
    if (!t.rowCount) fail('Choose valid default terms.');
  }
  const nextText = String(f.nextInvoiceNumber ?? '').trim();
  let nextInvoiceNumber = null;
  if (nextText) {
    if (!/^\d{1,8}$/.test(nextText) || Number(nextText) < 1) fail('The next invoice number is a whole number like 1001.');
    nextInvoiceNumber = Number(nextText);
    const { rows: [cur] } = await pool.query('SELECT next_invoice_number FROM sales_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
    // Unchanged from what's saved: fine even after numbering has passed it.
    if (Number(cur?.next_invoice_number) !== nextInvoiceNumber) {
    const { rows } = await pool.query(
      `SELECT coalesce(max(substring(doc_number FROM '^INV-(\\d+)$')::bigint), 0) AS n FROM txn WHERE org_id = $1 AND entity_id = $2 AND type = 'invoice'`,
      [orgId, entityId]);
    if (nextInvoiceNumber <= Number(rows[0].n)) fail(`Invoice INV-${String(rows[0].n).padStart(4, '0')} already exists. Choose a number after ${rows[0].n}.`);
    }
  }
  await upsert(pool, { orgId, entityId }, {
    default_terms_id: defaultTermsId,
    default_delivery: ['none', 'email', 'print'].includes(f.defaultDelivery) ? f.defaultDelivery : 'none',
    custom_numbers: on(f.customNumbers), next_invoice_number: nextInvoiceNumber, service_date: on(f.serviceDate), discount: on(f.discount),
    shipping: on(f.shipping), deposit: on(f.deposit),
    statement_kind: ['balance_forward', 'open_item', 'transaction'].includes(f.statementKind) ? f.statementKind : 'balance_forward',
    statement_aging: on(f.statementAging),
  });
}

// ---- Settings → Messages and reminders ----

const MAX_RULES = 3;

// fields: tpl_<kind>_subject / _greeting / _body, cc, bcc, copyMe, remindersOn, rule_days (up to 3; negative = before due).
export async function saveMessageSettings(pool, { orgId, entityId, fields: f, today, current }) {
  const templates = {};
  for (const [kind] of TEMPLATE_KINDS) {
    const t = { subject: text(f[`tpl_${kind}_subject`], 200), greeting: text(f[`tpl_${kind}_greeting`], 200), body: String(f[`tpl_${kind}_body`] ?? '').replace(/\r\n/g, '\n').trim().slice(0, 5000) || null };
    const d = DEFAULT_TEMPLATES[kind];
    const changed = Object.fromEntries(Object.entries(t).filter(([k, v]) => v !== null && v !== d[k]));
    if (Object.keys(changed).length) templates[kind] = changed;
  }
  const emails = v => {
    const list = String(v ?? '').split(/[,;\s]+/).map(s => s.trim()).filter(Boolean).slice(0, 5);
    for (const e of list) if (!EMAIL.test(e)) fail(`“${e}” isn’t an email address.`);
    return list.length ? list.join(', ') : null;
  };
  const rules = [];
  for (const raw of [].concat(f.rule_days ?? []).slice(0, MAX_RULES)) {
    const s = String(raw).trim();
    if (!s) continue;
    if (!/^[+-]?\d{1,3}$/.test(s) || Math.abs(Number(s)) > 365) fail('Reminder days are whole numbers like -3 (before due) or 7 (after due), up to 365.');
    if (!rules.some(r => r.days === Number(s))) rules.push({ days: Number(s) });
  }
  const remindersOn = on(f.remindersOn);
  if (remindersOn && !rules.length) fail('Add at least one reminder (e.g. 7 days after the due date), or turn reminders off.');
  rules.sort((a, b) => a.days - b.days);
  await upsert(pool, { orgId, entityId }, {
    templates: JSON.stringify(templates), cc: emails(f.cc), bcc: emails(f.bcc), copy_me: on(f.copyMe), reminders_on: remindersOn,
    // Turning reminders on starts from today, so old invoices don't all get reminders at once.
    reminders_from: remindersOn ? (current.remindersOn && current.remindersFrom ? current.remindersFrom : today) : null,
    reminder_rules: JSON.stringify(rules),
  });
}

// ---- Form styles ----

export const FONTS = [['helvetica', 'Clean (Helvetica)'], ['times', 'Classic (Times)'], ['courier', 'Typewriter (Courier)']];
const STYLE_DEFAULTS = { showLogo: true, accent: '#0f5c5c', font: 'helvetica', showTerms: true, showDueDate: true, showProject: true,
  showServiceDate: true, showMessage: true, footer: null };

export async function getFormStyle(db, { orgId, entityId }) {
  const { rows: [r] } = await db.query('SELECT * FROM form_style WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  if (!r) return { ...STYLE_DEFAULTS };
  return { showLogo: r.show_logo, accent: r.accent, font: r.font, showTerms: r.show_terms, showDueDate: r.show_due_date, showProject: r.show_project,
    showServiceDate: r.show_service_date, showMessage: r.show_message, footer: r.footer };
}

// Checks form fields and returns the style (also used for the preview, which isn't saved).
export function parseFormStyle(f) {
  const accent = String(f.accent ?? '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(accent)) fail('The accent color looks like #0f5c5c.');
  return { showLogo: on(f.showLogo), accent, font: FONTS.some(([k]) => k === f.font) ? f.font : 'helvetica', showTerms: on(f.showTerms),
    showDueDate: on(f.showDueDate), showProject: on(f.showProject), showServiceDate: on(f.showServiceDate), showMessage: on(f.showMessage),
    footer: String(f.footer ?? '').replace(/\r\n/g, '\n').trim().slice(0, 500) || null };
}

export async function saveFormStyle(pool, { orgId, entityId, fields }) {
  const s = parseFormStyle(fields);
  await pool.query(
    `INSERT INTO form_style (org_id, entity_id, show_logo, accent, font, show_terms, show_due_date, show_project, show_service_date, show_message, footer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (org_id, entity_id) DO UPDATE SET show_logo = $3, accent = $4, font = $5, show_terms = $6, show_due_date = $7, show_project = $8,
       show_service_date = $9, show_message = $10, footer = $11`,
    [orgId, entityId, s.showLogo, s.accent, s.font, s.showTerms, s.showDueDate, s.showProject, s.showServiceDate, s.showMessage, s.footer]);
}
