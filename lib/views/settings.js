import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField } from './forms.js';
import { formatDateTime } from './format.js';
import { canAccess } from '../domain/roles.js';
import { BUSINESS_TYPES } from '../data/settings.js';
import { taxProfileFields } from './tax-profile-fields.js';

// Settings sections, grouped. [key, label, one-line description]. The phone shows /settings as this list.
export const SETTINGS_GROUPS = [
  ['Morning View', [['morning', 'Morning View', 'Your morning preferences and balance floors']]],
  ['Company', [['company', 'Company', 'Name, legal name, tax ID, address and logo'], ['users', 'Users', 'Who can sign in and what each person can do'],
    ['email', 'Email', 'The address this company sends from'], ['payments', 'Payments', 'Let customers pay invoices online']]],
  ['Sales', [['sales', 'Sales', 'Invoice defaults, numbers, discounts, deposits, statements'],
    ['messages', 'Messages and reminders', 'Email wording, copies and automatic reminders'], ['form-styles', 'Form styles', 'Logo, color, font and footer on PDFs'],
    ['items', 'Products and services', 'What you sell and buy, prices and stock'], ['price-rules', 'Price rules', 'Special prices for customers or products'],
    ['terms', 'Terms', 'Payment terms like Net 30'],
    ['late-fees', 'Late fees', 'Automatic fees on overdue invoices']]],
  ['Expenses', [['bills', 'Bills and expenses', 'Bill approval and check numbers']]],
  ['Accounting', [['accounting', 'Accounting', 'Fiscal year, method, date format, classes, billable expenses, automation'],
    ['accounts', 'Chart of accounts', 'Accounts, balances and registers'], ['bank-feeds', 'Bank connections', 'Bank and card feeds from ledgerline'], ['ai', 'AI', 'Claude or OpenRouter for vendor research and receipts'], ['text-receipts', 'Text receipts', 'Text a receipt photo to a Twilio number'], ['currencies', 'Currencies', 'Bill and pay in other currencies'], ['classes', 'Classes', 'Split the books by part of the business'],
    ['locations', 'Locations', 'Stores, departments or divisions'], ['tags', 'Tags', 'Labels to group and filter transactions']]],
];
export const SETTINGS_TABS = SETTINGS_GROUPS.flatMap(([, tabs]) => tabs.map(([key, label]) => [key, label]));

// People and the list of companies are for organization-level admins only (not an admin limited to some companies).
const allowed = (role, key, orgAdmin = true, morningViewer = false) => key === 'morning' ? morningViewer : canAccess(role ?? 'admin', 'GET', `/settings/${key}`) && (orgAdmin !== false || !['users', 'companies', 'ai', 'text-receipts'].includes(key));

export function settingsIndexPage({ entityName, csrf, flash = null, role, orgAdmin = true, morningViewer = false }) {
  return layout({
    title: 'Settings', entityName, csrf, flash,
    body: html`<h1>Settings</h1>
<div class="settings-index">
${SETTINGS_GROUPS.map(([group, tabs]) => {
    const mine = tabs.filter(([key]) => allowed(role, key, orgAdmin, morningViewer));
    return mine.length ? html`<section class="card"><h2>${group}</h2><ul class="link-list">
  ${mine.map(([key, label, about]) => html`<li><a href="/settings/${key}"><strong>${label}</strong><small class="muted">${about}</small></a></li>`)}
</ul></section>` : '';
  })}
</div>`,
  });
}

export function settingsLayout({ entityName, csrf, flash, tab, body, role, orgAdmin = true, morningViewer = false }) {
  return layout({
    title: 'Settings', entityName, csrf, flash,
    body: html`<p class="settings-back"><a href="/settings">‹ All settings</a></p>
<h1>Settings</h1>
<nav class="tabs settings-tabs" aria-label="Settings sections">
  ${SETTINGS_TABS.filter(([key]) => allowed(role, key, orgAdmin, morningViewer)).map(([key, label]) => html`<a href="/settings/${key}" class="${key === tab ? 'tab active' : 'tab'}"${key === tab ? html` aria-current="page"` : ''}>${label}</a>`)}
</nav>
<section class="tab-panel">${body}</section>`,
  });
}

// Mail server presets: [key, label, host, port, security, username hint].
export const MAIL_PRESETS = [
  ['gmail', 'Gmail / Google Workspace', 'smtp.gmail.com', 587, 'starttls', 'Your full Gmail address; password is a Google app password'],
  ['outlook', 'Outlook / Microsoft 365', 'smtp.office365.com', 587, 'starttls', 'Your full Outlook address'],
  ['postmark', 'Postmark', 'smtp.postmarkapp.com', 587, 'starttls', 'Username and password are both your Postmark server token'],
  ['resend', 'Resend', 'smtp.resend.com', 465, 'tls', 'Username is “resend”; password is your Resend API key'],
];

const COMPANY_FIELDS = ['name', 'email', 'phone', 'line1', 'city', 'state', 'postal', 'legalName', 'ein', 'clearEin', 'businessType', 'website',
  'customerEmail', 'c_line1', 'c_city', 'c_state', 'c_postal'];
export const companyToValues = c => ({
  name: c.name, email: c.email, phone: c.phone, line1: c.address?.line1, city: c.address?.city, state: c.address?.state, postal: c.address?.postal,
  legalName: c.legal_name, ein: '', businessType: c.business_type, website: c.website, customerEmail: c.customer_email,
  c_line1: c.customer_address?.line1, c_city: c.customer_address?.city, c_state: c.customer_address?.state, c_postal: c.customer_address?.postal,
});
export const companyFormValues = params => Object.fromEntries(COMPANY_FIELDS.map(k => [k, params.get(k) ?? '']));

const addressFields = (v, prefix = '') => html`
    ${field('Street', `${prefix}line1`, v[`${prefix}line1`], { cls: 'wide' })}
    ${field('City', `${prefix}city`, v[`${prefix}city`])}
    ${field('State', `${prefix}state`, v[`${prefix}state`], { attrs: 'size="4"' })}
    ${field('ZIP', `${prefix}postal`, v[`${prefix}postal`], { attrs: 'size="8"' })}`;

export function companySettingsPage({ entityName, csrf, flash = null, v, company, hasKey, role, error = null, logoError = null, tax = null, suggestion = null }) {
  return settingsLayout({
    entityName, csrf, flash, tab: 'company', role,
    body: html`<form method="post" action="/settings/company" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <h2>Company</h2>
  <p class="muted">Shown at the top of invoices, statements, and emails.</p>
  <div class="form-grid">
    ${field('Company name', 'name', v.name, { required: true })}
    ${field('Company email', 'email', v.email, { type: 'email', hint: 'Printed on PDFs. Where email is sent from is set on the Email tab.' })}
    ${field('Phone', 'phone', v.phone, { type: 'tel' })}
    ${field('Website', 'website', v.website, { attrs: 'inputmode="url" placeholder="www.example.com"' })}
  </div>
  <fieldset class="address"><legend>Company address</legend>${addressFields(v)}</fieldset>
  <h2>Legal</h2>
  <div class="form-grid">
    ${field('Legal name', 'legalName', v.legalName, { hint: 'If different from the company name, e.g. “Sample Feed Co. LLC”.' })}
    ${selectField('Business type', 'businessType', BUSINESS_TYPES, v.businessType, { blank: 'Choose…' })}
    ${field('EIN or SSN', 'ein', '', { attrs: company.has_ein ? 'autocomplete="off" inputmode="numeric" placeholder="Saved — leave blank to keep"' : 'autocomplete="off" inputmode="numeric" placeholder="12-3456789"',
      hint: !hasKey ? 'The server has no SETTINGS_KEY yet, so a tax ID can’t be saved.'
        : company.has_ein ? `Saved, ending in ${company.ein_last4}. Stored encrypted; only the last 4 digits are shown.` : 'Stored encrypted; only the last 4 digits are shown.' })}
  </div>
  ${company.has_ein ? html`<label class="check"><input type="checkbox" name="clearEin" value="1"> Remove the saved EIN/SSN (ends in ${company.ein_last4})</label>` : ''}
  ${tax ? html`<h2>Tax</h2>
  <p class="muted">The same tax setup as Tax → this company’s setup page: changing it here changes it there. Changing the return type or a method is a reviewed change: give the reason.</p>
  ${taxProfileFields(tax, { suggestion })}` : ''}
  <h2>What customers see</h2>
  <p class="muted">Leave blank to use the company email and address above.</p>
  <div class="form-grid">${field('Customer-facing email', 'customerEmail', v.customerEmail, { type: 'email' })}</div>
  <fieldset class="address"><legend>Customer-facing address</legend>${addressFields(v, 'c_')}</fieldset>
  <div class="form-actions"><button class="primary">Save company</button></div>
</form>
<section class="logo-settings">
  <h2>Logo</h2>
  ${errorBanner(logoError)}
  ${company.has_logo ? html`<p><img class="logo-preview" src="/company/logo" alt="Company logo"></p>` : html`<p class="muted">No logo yet. It will print on invoices, statements and other forms.</p>`}
  <form method="post" action="/settings/company/logo" enctype="multipart/form-data" class="upload">
    ${csrfField(csrf)}
    <label class="field"><span>PNG or JPEG, up to 1 MB</span><input type="file" name="logo" accept="image/png,image/jpeg" required></label>
    <button>${company.has_logo ? 'Replace logo' : 'Upload logo'}</button>
  </form>
  ${company.has_logo ? html`<form method="post" action="/settings/company/logo/delete" class="inline" data-confirm="Remove the logo?">${csrfField(csrf)}<button class="link">Remove logo</button></form>` : ''}
</section>`,
  });
}

export const emailToValues = s => ({ mode: s.mode, fromName: s.fromName, fromEmail: s.fromEmail, replyTo: s.replyTo, host: s.host, port: s.port, security: s.security, user: s.user, password: '' });
export const emailFormValues = params => Object.fromEntries(['mode', 'fromName', 'fromEmail', 'replyTo', 'host', 'port', 'security', 'user', 'password'].map(k => [k, params.get(k) ?? '']));

export function emailSettingsPage({ entityName, csrf, flash = null, v, settings, timeZone, hasKey, role, error = null }) {
  const smtp = v.mode === 'smtp';
  const test = settings.lastTest;
  return settingsLayout({
    entityName, csrf, flash, tab: 'email', role,
    body: html`<div class="email-status ${smtp ? (test?.ok ? 'ok' : 'warn') : 'off'}">
  ${smtp
    ? html`<strong>Sending from ${settings.fromEmail ?? v.fromEmail}.</strong>
      ${test ? (test.ok ? html` Test email succeeded ${formatDateTime(test.at, timeZone)}.` : html` Last test failed ${formatDateTime(test.at, timeZone)}: ${test.error}`) : ' Not tested yet. Send a test email below.'}`
    : html`<strong>Email isn’t connected.</strong> Send records each message on the customer’s page but nothing is emailed.`}
</div>
<form method="post" action="/settings/email" class="editor" data-mail-settings>
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <fieldset class="choice"><legend>How should this company send email?</legend>
    <label class="check"><input type="radio" name="mode" value="record"${smtp ? '' : html` checked`}> Don’t email anyone yet (record only)</label>
    <label class="check"><input type="radio" name="mode" value="smtp"${smtp ? html` checked` : ''}> Send from my email account</label>
  </fieldset>
  <h2>Sender</h2>
  <div class="form-grid">
    ${field('Send from (email address)', 'fromEmail', v.fromEmail, { type: 'email', hint: 'Invoices and statements come from this address.' })}
    ${field('Sender name', 'fromName', v.fromName, { hint: `Customers see this name, e.g. “${entityName}”.` })}
    ${field('Reply-to (optional)', 'replyTo', v.replyTo, { type: 'email', hint: 'Where customer replies go, if not the send-from address.' })}
  </div>
  <h2>Mail server</h2>
  <p class="muted">Pick your provider to fill in the server details, then enter the login for that address.</p>
  <div class="form-grid">
    ${selectField('Provider', 'preset', MAIL_PRESETS.map(([key, label, host, port, security, hint]) =>
      [key, label, `data-host="${host}" data-port="${port}" data-security="${security}" data-hint="${hint}"`]), MAIL_PRESETS.find(p => p[2] === v.host)?.[0] ?? '', { blank: 'Other / custom', attrs: 'data-preset' })}
    ${field('Mail server', 'host', v.host, { attrs: 'placeholder="smtp.example.com" autocomplete="off"' })}
    ${field('Port', 'port', v.port, { attrs: 'inputmode="numeric" size="6"' })}
    ${selectField('Security', 'security', [['starttls', 'STARTTLS (port 587)'], ['tls', 'SSL/TLS (port 465)']], v.security)}
    ${field('Username', 'user', v.user, { attrs: 'autocomplete="off"', hint: MAIL_PRESETS.find(p => p[2] === v.host)?.[5] ?? '' })}
    ${field('Password', 'password', '', { type: 'password', attrs: `autocomplete="new-password"${settings.hasPassword ? ' placeholder="Saved — leave blank to keep"' : ''}`,
      hint: hasKey ? 'Stored encrypted.' : 'The server has no SETTINGS_KEY yet, so a password can’t be saved.' })}
  </div>
  <div class="form-actions"><button class="primary">Save email settings</button></div>
</form>
${smtp && settings.mode === 'smtp' ? html`<form method="post" action="/settings/email/test" class="test-email">
  ${csrfField(csrf)}
  <h2>Send a test email</h2>
  <div class="search">
    <input type="email" name="to" value="${settings.fromEmail ?? ''}" aria-label="Send the test to" required>
    <button>Send test</button>
  </div>
</form>` : ''}`,
  });
}
