import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { PAYMENT_METHODS } from './txn-form.js';

// Customer -> raw form values.
export function customerToValues(c) {
  const a = c.billing_address ?? {}, s = c.shipping_address ?? {};
  return {
    displayName: c.display_name, companyName: c.company_name, email: c.email, phone: c.phone, mobile: c.mobile,
    billingLine1: a.line1, billingCity: a.city, billingState: a.state, billingPostal: a.postal,
    shippingSameAsBilling: c.shipping_same_as_billing, shippingLine1: s.line1, shippingCity: s.city, shippingState: s.state, shippingPostal: s.postal,
    currency: c.currency ?? '', noteLine: c.note_line, termsId: c.terms_id, taxExempt: c.tax_exempt, taxExemptReason: c.tax_exempt_reason,
    preferredPaymentMethod: c.preferred_payment_method, preferredDelivery: c.preferred_delivery,
    lateFeesEnabled: c.late_fees_enabled, active: c.active, sendReminders: !c.no_reminders,
    title: c.title, firstName: c.first_name, middleName: c.middle_name, lastName: c.last_name, suffix: c.suffix, cc: c.cc, bcc: c.bcc,
    fax: c.fax, otherPhone: c.other_phone, website: c.website, checkName: c.check_name, parentCustomerId: c.parent_customer_id ?? '',
    isSub: c.parent_customer_id !== null && c.parent_customer_id !== undefined, emailMarketing: c.email_marketing,
    creditLimit: c.credit_limit_cents === null || c.credit_limit_cents === undefined ? '' : (Number(c.credit_limit_cents) / 100).toFixed(2),
    customerType: c.customer_type, invoiceLanguage: c.invoice_language ?? 'English', source: c.source, referredBy: c.referred_by,
    jobTitle: c.job_title, contactRole: c.contact_role, preferredContact: c.preferred_contact ?? '', industry: c.industry,
    social: c.social ?? [], otherAddresses: c.other_addresses ?? [],
  };
}

export const NEW_CUSTOMER_VALUES = { shippingSameAsBilling: true, lateFeesEnabled: true, sendReminders: true, active: true, preferredDelivery: 'email',
  invoiceLanguage: 'English', social: [], otherAddresses: [] };

const TEXT_FIELDS = ['displayName', 'companyName', 'email', 'phone', 'mobile', 'billingLine1', 'billingCity', 'billingState', 'billingPostal',
  'shippingLine1', 'shippingCity', 'shippingState', 'shippingPostal', 'noteLine', 'termsId', 'taxExemptReason', 'preferredPaymentMethod', 'preferredDelivery',
  'title', 'firstName', 'middleName', 'lastName', 'suffix', 'cc', 'bcc', 'fax', 'otherPhone', 'website', 'checkName', 'parentCustomerId',
  'creditLimit', 'customerType', 'invoiceLanguage', 'source', 'referredBy', 'jobTitle', 'contactRole', 'preferredContact', 'industry'];
const BOOL_FIELDS = ['shippingSameAsBilling', 'taxExempt', 'lateFeesEnabled', 'sendReminders', 'active', 'emailMarketing', 'isSub'];
const MORE_FIELDS = ['title', 'firstName', 'middleName', 'lastName', 'suffix', 'cc', 'bcc', 'fax', 'otherPhone', 'website', 'checkName', 'parentCustomerId',
  'creditLimit', 'customerType', 'invoiceLanguage', 'source', 'referredBy', 'jobTitle', 'contactRole', 'preferredContact', 'industry', 'emailMarketing', 'isSub'];
export const MAX_OTHER_ADDRESSES = 3;
export const MAX_SOCIAL = 3;

// Posted form (URLSearchParams) -> values for saveCustomer.
export function customerFormValues(params) {
  if (params.has('currency')) return { ...customerFormValuesBase(params), currency: params.get('currency') ?? '' };
  return customerFormValuesBase(params);
}
function customerFormValuesBase(params) {
  const v = {};
  for (const k of TEXT_FIELDS) v[k] = params.get(k) ?? '';
  for (const k of BOOL_FIELDS) v[k] = params.get(k) === '1';
  if (!v.isSub) v.parentCustomerId = '';
  // A form without the fuller fields (an older page, a script) leaves them as they are.
  if (!params.has('firstName') && !params.has('creditLimit')) {
    for (const k of MORE_FIELDS) delete v[k];
    return v;
  }
  const all = k => params.getAll(k);
  v.otherAddresses = all('addrLine1').map((line1, i) => ({ label: all('addrLabel')[i] ?? '', line1, city: all('addrCity')[i] ?? '', state: all('addrState')[i] ?? '', postal: all('addrPostal')[i] ?? '' }));
  v.social = all('socialUrl').map((url, i) => ({ network: all('socialNetwork')[i] ?? '', url }));
  v.openingBalance = params.get('openingBalance') ?? '';
  v.openingAsOf = params.get('openingAsOf') ?? '';
  return v;
}

// cur: { currencies, locked } from partyCurrencyChoices (empty list when multicurrency is off).
// cur: { currencies, locked } from partyCurrencyChoices (empty list when multicurrency is off).
// parents: other customers a sub-customer can sit under. QBO's sections: name and contact, addresses, notes, payments,
// additional info, relationships.
export function customerForm({ entityName, csrf, customerId = null, terms, v, error = null, cur = null, parents = [], today = '' }) {
  const address = (prefix, title) => html`<fieldset class="address"><legend>${title}</legend>
    ${field('Street', `${prefix}Line1`, v[`${prefix}Line1`], { cls: 'wide' })}
    ${field('City', `${prefix}City`, v[`${prefix}City`])}
    ${field('State', `${prefix}State`, v[`${prefix}State`], { attrs: 'size="4"' })}
    ${field('ZIP', `${prefix}Postal`, v[`${prefix}Postal`], { attrs: 'size="8"' })}
  </fieldset>`;
  const others = [...(v.otherAddresses ?? [])];
  while (others.length < MAX_OTHER_ADDRESSES) others.push({});
  const social = [...(v.social ?? [])];
  while (social.length < MAX_SOCIAL) social.push({});
  const back = customerId ? `/customers/${customerId}` : '/customers';
  return layout({
    title: customerId ? `Edit ${v.displayName}` : 'New customer', entityName, csrf,
    body: html`<div class="crumbs"><a href="${back}">‹ Back</a></div>
<form method="post" action="${customerId ? `/customers/${customerId}` : '/customers'}" class="card editor customer-editor">
  ${csrfField(csrf)}
  <h1>${customerId ? 'Edit customer' : 'New customer'}</h1>
  ${errorBanner(error)}
  <section class="form-section"><h2>Name and contact</h2>
  <div class="form-grid name-grid">
    ${field('Title', 'title', v.title, { attrs: 'size="6"' })}
    ${field('First name', 'firstName', v.firstName)}
    ${field('Middle name', 'middleName', v.middleName)}
    ${field('Last name', 'lastName', v.lastName)}
    ${field('Suffix', 'suffix', v.suffix, { attrs: 'size="6"' })}
  </div>
  <div class="form-grid">
    ${field('Company name', 'companyName', v.companyName)}
    ${field('Customer display name', 'displayName', v.displayName, { required: !!customerId, hint: customerId ? '' : 'Left blank, it’s the company name or the person’s name' })}
    ${field('Email', 'email', v.email, { type: 'email' })}
    ${field('Cc', 'cc', v.cc, { hint: 'Separate addresses with commas' })}
    ${field('Bcc', 'bcc', v.bcc)}
    ${field('Phone number', 'phone', v.phone, { type: 'tel' })}
    ${field('Mobile number', 'mobile', v.mobile, { type: 'tel' })}
    ${field('Fax', 'fax', v.fax, { type: 'tel' })}
    ${field('Other', 'otherPhone', v.otherPhone, { type: 'tel' })}
    ${field('Website', 'website', v.website)}
    ${field('Name to print on checks', 'checkName', v.checkName)}
  </div>
  <div class="sub-customer">
    ${checkbox('Is a sub-customer', 'isSub', v.isSub)}
    ${selectField('Parent customer', 'parentCustomerId', parents.map(p => [p.customer_id, p.display_name]), v.parentCustomerId, { blank: 'Choose a customer' })}
  </div>
  ${checkbox('Email marketing: this person gave me permission to email them marketing', 'emailMarketing', v.emailMarketing)}
  </section>

  <section class="form-section"><h2>Addresses</h2>
  ${address('billing', 'Billing address')}
  ${checkbox('Shipping address same as billing', 'shippingSameAsBilling', v.shippingSameAsBilling)}
  ${address('shipping', 'Shipping address (default)')}
  <details class="more-addresses"${others.some(a => a.line1) ? ' open' : ''}><summary>Other shipping addresses</summary>
    ${others.map((a, i) => html`<fieldset class="address"><legend>Address ${i + 1}</legend>
      ${field('Name for this address', 'addrLabel', a.label, { attrs: `id="addrLabel${i}"` })}
      ${field('Street', 'addrLine1', a.line1, { cls: 'wide', attrs: `id="addrLine1${i}"` })}
      ${field('City', 'addrCity', a.city, { attrs: `id="addrCity${i}"` })}
      ${field('State', 'addrState', a.state, { attrs: `size="4" id="addrState${i}"` })}
      ${field('ZIP', 'addrPostal', a.postal, { attrs: `size="8" id="addrPostal${i}"` })}
    </fieldset>`)}
  </details>
  </section>

  <section class="form-section"><h2>Notes</h2>
  ${field('Notes', 'noteLine', v.noteLine, { cls: 'wide', hint: 'Shown on the customer page' })}
  <p class="muted small">Attachments go on the customer’s Documents tab.</p>
  </section>

  <section class="form-section"><h2>Payments</h2>
  <div class="form-grid">
    ${selectField('Primary payment method', 'preferredPaymentMethod', PAYMENT_METHODS.map(m => [m, m]), v.preferredPaymentMethod, { blank: '—' })}
    ${selectField('Terms', 'termsId', terms.map(t => [t.terms_id, t.name]), v.termsId, { blank: 'None' })}
    ${selectField('Sales form delivery', 'preferredDelivery', [['email', 'Email'], ['print', 'Print later'], ['none', 'None']], v.preferredDelivery)}
    ${selectField('Language to use when you send invoices', 'invoiceLanguage', [['English', 'English'], ['Spanish', 'Spanish'], ['French', 'French']], v.invoiceLanguage)}
    ${field('Credit limit', 'creditLimit', v.creditLimit, { attrs: 'inputmode="decimal"', hint: 'Warns when a new invoice would go over it' })}
    ${cur?.currencies.length ? (cur.locked
      ? html`<div class="field"><span>Currency</span><strong>${v.currency || 'USD (home)'}</strong><small class="muted">Fixed: there are transactions in it.</small></div>`
      : selectField('Currency', 'currency', cur.currencies.map(c => [c.code, `${c.code} — ${c.name}`]), v.currency, { blank: 'USD (home currency)' })) : ''}
  </div>
  </section>

  <section class="form-section"><h2>Additional info</h2>
  <div class="form-grid">
    ${field('Customer type', 'customerType', v.customerType)}
    ${field('Tax exemption reason', 'taxExemptReason', v.taxExemptReason)}
    ${customerId ? '' : html`${field('Opening balance', 'openingBalance', v.openingBalance ?? '', { attrs: 'inputmode="decimal"', hint: 'What this customer already owes you' })}
      ${field('As of', 'openingAsOf', v.openingAsOf || today, { type: 'date' })}`}
  </div>
  <div class="checks">
    ${checkbox('Tax exempt', 'taxExempt', v.taxExempt)}
    ${checkbox('Charge late fees', 'lateFeesEnabled', v.lateFeesEnabled)}
    ${checkbox('Send automatic invoice reminders', 'sendReminders', v.sendReminders)}
    ${checkbox('Active', 'active', v.active)}
  </div>
  </section>

  <section class="form-section"><h2>Relationships &amp; sales</h2>
  <div class="form-grid">
    ${field('Source', 'source', v.source, { hint: 'Where this customer came from' })}
    ${field('Referred by', 'referredBy', v.referredBy)}
    ${field('Job title', 'jobTitle', v.jobTitle)}
    ${field('Role', 'contactRole', v.contactRole)}
    ${selectField('Preferred contact method', 'preferredContact', [['email', 'Email'], ['phone', 'Phone'], ['mobile', 'Mobile'], ['text', 'Text message'], ['mail', 'Mail']], v.preferredContact, { blank: '—' })}
    ${field('Industry', 'industry', v.industry)}
  </div>
  <fieldset class="social"><legend>Social media</legend>
    ${social.map((x, i) => html`<div class="social-row">
      ${selectField('Network', 'socialNetwork', [['Facebook', 'Facebook'], ['Instagram', 'Instagram'], ['LinkedIn', 'LinkedIn'], ['X', 'X'], ['YouTube', 'YouTube'], ['Other', 'Other']], x.network, { blank: '—', attrs: `id="socialNetwork${i}"` })}
      ${field('Profile link', 'socialUrl', x.url, { attrs: `id="socialUrl${i}"` })}</div>`)}
  </fieldset>
  </section>

  <div class="form-actions">
    <a href="${back}">Cancel</a>
    <button class="primary">Save customer</button>
  </div>
</form>`,
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Edit ▾ → Merge contacts: everything moves to the customer kept, then this one is deleted.
export function customerMergePage({ entityName, csrf, customer, choices, counts, error = null }) {
  return layout({
    title: `Merge ${customer.display_name}`, entityName, csrf,
    body: html`<div class="crumbs"><a href="/customers/${customer.customer_id}">‹ ${customer.display_name}</a></div>
<form method="post" action="/customers/${customer.customer_id}/merge" class="card editor">
  ${csrfField(csrf)}
  <h1>Merge ${customer.display_name}</h1>
  ${errorBanner(error)}
  <p>Everything on <strong>${customer.display_name}</strong> — ${plural(counts.transactions, 'transaction')}, ${plural(counts.projects, 'project')},
    ${plural(counts.documents, 'document')}, messages and history — moves to the customer you pick. Then <strong>${customer.display_name}</strong> is deleted.
    This can’t be undone.</p>
  <div class="form-grid">
    ${selectField('Keep this customer', 'into', choices.map(c => [c.customer_id, c.display_name + (c.active ? '' : ' (inactive)')]), '', { blank: 'Choose…' })}
  </div>
  <div class="form-actions"><a href="/customers/${customer.customer_id}">Cancel</a>
    <button class="danger" data-confirm="Merge ${customer.display_name} and delete it? This can’t be undone.">Merge customers</button></div>
</form>`,
  });
}
