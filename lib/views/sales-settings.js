import { html } from './html.js';
import { csrfField, errorBanner, field, selectField, checkbox } from './forms.js';
import { formatShortDate } from '../domain/dates.js';
import { TEMPLATE_KINDS, DEFAULT_TEMPLATES, PLACEHOLDERS, FONTS } from '../data/sales-settings.js';

const DELIVERY = [['none', 'Just save'], ['email', 'Email it to the customer'], ['print', 'Open the PDF to print']];
const STATEMENT_KINDS = [['balance_forward', 'Balance forward'], ['open_item', 'Open item'], ['transaction', 'Transaction statement']];

export const salesToValues = s => ({
  defaultTermsId: s.defaultTermsId ? String(s.defaultTermsId) : '', defaultDelivery: s.defaultDelivery, customNumbers: s.customNumbers,
  nextInvoiceNumber: s.nextInvoiceNumber ? String(s.nextInvoiceNumber) : '', serviceDate: s.serviceDate, discount: s.discount, shipping: s.shipping,
  deposit: s.deposit, statementKind: s.statementKind, statementAging: s.statementAging,
});
export const salesFormValues = p => ({
  defaultTermsId: p.get('defaultTermsId') ?? '', defaultDelivery: p.get('defaultDelivery') ?? 'none', customNumbers: p.get('customNumbers') === '1',
  nextInvoiceNumber: p.get('nextInvoiceNumber') ?? '', serviceDate: p.get('serviceDate') === '1', discount: p.get('discount') === '1',
  shipping: p.get('shipping') === '1', deposit: p.get('deposit') === '1', statementKind: p.get('statementKind') ?? '', statementAging: p.get('statementAging') === '1',
});

export function salesSettingsBody({ csrf, v, terms, error = null }) {
  return html`<form method="post" action="/settings/sales" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <h2>Invoices</h2>
  <div class="form-grid">
    ${selectField('Default terms', 'defaultTermsId', terms.map(t => [t.terms_id, t.name]), v.defaultTermsId, { blank: 'None (due on the invoice date)' })}
    ${selectField('After saving a new invoice', 'defaultDelivery', DELIVERY, v.defaultDelivery)}
    ${field('Next invoice number', 'nextInvoiceNumber', v.nextInvoiceNumber, { attrs: 'inputmode="numeric" placeholder="Automatic"', hint: 'Numbers continue from here, e.g. 1001 makes the next one INV-1001.' })}
  </div>
  <p class="muted small">Default terms apply when the customer has none of their own.</p>
  ${checkbox('Let people type their own invoice numbers (custom numbers)', 'customNumbers', v.customNumbers)}
  ${checkbox('Service date column on lines', 'serviceDate', v.serviceDate)}
  ${checkbox('Discount (percent or amount, posted to Discounts Given)', 'discount', v.discount)}
  ${checkbox('Shipping (posted to Shipping Income)', 'shipping', v.shipping)}
  ${checkbox('Deposit on the invoice (money already received)', 'deposit', v.deposit)}
  <h2>Statements</h2>
  <div class="form-grid">${selectField('Default statement', 'statementKind', STATEMENT_KINDS, v.statementKind)}</div>
  ${checkbox('Show the aging table (current, 1–30, 31–60 …) on statements', 'statementAging', v.statementAging)}
  <div class="form-actions"><button class="primary">Save sales settings</button></div>
</form>`;
}

export const messagesToValues = s => {
  const v = { cc: s.cc ?? '', bcc: s.bcc ?? '', copyMe: s.copyMe, remindersOn: s.remindersOn, ruleDays: s.reminderRules.map(r => String(r.days)) };
  for (const [kind] of TEMPLATE_KINDS) for (const part of ['subject', 'greeting', 'body']) v[`tpl_${kind}_${part}`] = s.templates?.[kind]?.[part] ?? DEFAULT_TEMPLATES[kind][part];
  return v;
};
export const messagesFormValues = p => {
  const v = { cc: p.get('cc') ?? '', bcc: p.get('bcc') ?? '', copyMe: p.get('copyMe') === '1', remindersOn: p.get('remindersOn') === '1', ruleDays: p.getAll('rule_days') };
  for (const [kind] of TEMPLATE_KINDS) for (const part of ['subject', 'greeting', 'body']) v[`tpl_${kind}_${part}`] = p.get(`tpl_${kind}_${part}`) ?? '';
  return v;
};
// What saveMessageSettings expects.
export const messagesFields = v => ({ ...v, rule_days: v.ruleDays });

export function messagesSettingsBody({ csrf, v, remindersFrom, error = null }) {
  const days = [...v.ruleDays, '', '', ''].slice(0, 3);
  return html`<form method="post" action="/settings/messages" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <h2>Copies</h2>
  <div class="form-grid">
    ${field('Cc', 'cc', v.cc, { hint: 'Up to 5 addresses, separated by commas.' })}
    ${field('Bcc', 'bcc', v.bcc)}
  </div>
  ${checkbox('Email me a copy (to the company email in Settings → Company)', 'copyMe', v.copyMe)}
  <h2>Automatic reminders</h2>
  ${checkbox('Send reminder emails for unpaid invoices', 'remindersOn', v.remindersOn)}
  <p class="muted small">The daily job sends each reminder once per invoice. Use a minus sign for days before the due date (−3) and a plain number for days after (7).
  Customers can be left out on their Customer Details.${remindersFrom ? ` Reminders cover invoices due on or after ${formatShortDate(remindersFrom)}, when they were turned on.` : ''}</p>
  <div class="form-grid">
    ${days.map((d, i) => field(`Reminder ${i + 1}: days from the due date`, 'rule_days', d, { attrs: 'inputmode="numeric" size="5" placeholder="e.g. 7"' }))}
  </div>
  <h2>Email messages</h2>
  <p class="muted small">You can use ${PLACEHOLDERS.join(' ')} — they’re filled in when the email is sent.</p>
  ${TEMPLATE_KINDS.map(([kind, label]) => html`<details class="template"><summary>${label}</summary>
    ${field('Subject', `tpl_${kind}_subject`, v[`tpl_${kind}_subject`], { cls: 'wide' })}
    ${field('Greeting', `tpl_${kind}_greeting`, v[`tpl_${kind}_greeting`], { cls: 'wide' })}
    <label class="field wide"><span>Message</span><textarea name="tpl_${kind}_body" rows="7">${v[`tpl_${kind}_body`]}</textarea></label>
  </details>`)}
  <div class="form-actions"><button class="primary">Save messages</button></div>
</form>`;
}

export const styleToValues = s => ({ ...s, footer: s.footer ?? '' });
export const styleFormValues = p => ({
  showLogo: p.get('showLogo') === '1', accent: p.get('accent') ?? '', font: p.get('font') ?? '', showTerms: p.get('showTerms') === '1',
  showDueDate: p.get('showDueDate') === '1', showProject: p.get('showProject') === '1', showServiceDate: p.get('showServiceDate') === '1',
  showMessage: p.get('showMessage') === '1', footer: p.get('footer') ?? '',
});

export function formStylesBody({ csrf, v, hasLogo, error = null }) {
  return html`<form method="post" action="/settings/form-styles" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <p class="muted">Used on invoices, sales receipts, credit memos, statements, estimates, purchase orders and checks. The footer is also added to emails.</p>
  <div class="form-grid">
    <label class="field"><span>Accent color</span><input type="color" name="accent" value="${v.accent}"></label>
    ${selectField('Font', 'font', FONTS, v.font)}
  </div>
  ${checkbox(hasLogo ? 'Show the logo' : 'Show the logo (upload one in Settings → Company)', 'showLogo', v.showLogo)}
  <fieldset class="choice"><legend>Show on the form</legend>
    ${checkbox('Terms', 'showTerms', v.showTerms)}
    ${checkbox('Due date', 'showDueDate', v.showDueDate)}
    ${checkbox('Project', 'showProject', v.showProject)}
    ${checkbox('Service date', 'showServiceDate', v.showServiceDate)}
    ${checkbox('Message (the memo on the transaction)', 'showMessage', v.showMessage)}
  </fieldset>
  <label class="field wide"><span>Footer</span><textarea name="footer" rows="3" maxlength="500">${v.footer}</textarea>
    <small class="muted">E.g. “Thank you for your business! Make checks payable to …”</small></label>
  <div class="form-actions">
    <button formaction="/settings/form-styles/preview.pdf" formtarget="_blank" class="button">Preview PDF</button>
    <button class="primary">Save form style</button>
  </div>
</form>`;
}
