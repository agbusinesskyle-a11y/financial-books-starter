import { html } from './html.js';
import { layout } from './layout.js';
import { csrfField, errorBanner, selectField, checkbox } from './forms.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { PROCESSORS } from '../payments/processors.js';

const METHOD = { card: 'Credit or debit card', ach: 'Bank transfer (ACH)' };

// The customer's page from the "Pay now" link.
export function payPage({ link: l, quotes, error = null }) {
  const due = Number(l.open_cents);
  const paid = l.used_at || due <= 0 || l.voided_at;
  return layout({
    title: `Pay invoice ${l.doc_number ?? ''}`, entityName: l.entity_name, bare: true,
    body: html`<section class="card editor public-form pay-page">
  <h1>Invoice ${l.doc_number ?? ''}</h1>
  <p>From <strong>${l.entity_name}</strong> to ${l.customer_name}${l.due_date ? html` · due ${formatShortDate(l.due_date)}` : ''}</p>
  ${errorBanner(error)}
  ${paid ? html`<p class="flash ok">Nothing is due on this invoice. Thank you!</p>`
    : !l.settings.enabled || !Object.keys(quotes).length ? html`<p>Online payment isn’t available right now. Contact ${l.entity_name} to pay.</p>`
    : html`<p class="big-total">Balance due <strong>${formatCents(due)}</strong></p>
  ${l.settings.processor === 'test' ? html`<p class="ledger-check warn">Test mode: no real money moves.</p>` : ''}
  <form method="post">
    <fieldset class="choice"><legend>How would you like to pay?</legend>
      ${Object.entries(quotes).map(([k, q], i) => html`<label class="check"><input type="radio" name="method" value="${k}"${i === 0 ? html` checked` : ''} required>
        ${METHOD[k]} — ${formatCents(q.charged)}${q.surcharge ? html` <small class="muted">(includes a ${formatCents(q.surcharge)} processing fee)</small>` : ''}</label>`)}
    </fieldset>
    <div class="form-actions"><button class="primary">Continue to payment</button></div>
  </form>`}
</section>`,
  });
}

export function testCheckoutPage({ checkout: c }) {
  return layout({
    title: 'Test checkout', bare: true, entityName: 'Test processor',
    body: html`<section class="card editor public-form">
  <h1>Test checkout</h1>
  <p class="ledger-check warn">This stands in for the card processor while Financial Books is in test mode. No real money moves.</p>
  <p>${c.entity_name} · invoice ${c.doc_number ?? ''} · ${METHOD[c.method]}</p>
  <p class="big-total">Pay <strong>${formatCents(Number(c.charged_cents))}</strong></p>
  ${c.status === 'open' ? html`<form method="post" class="form-actions">
    <button name="action" value="cancel">Cancel</button>
    <button class="primary" name="action" value="pay">Pay ${formatCents(Number(c.charged_cents))} (test)</button>
  </form>` : html`<p>This checkout is ${c.status}.</p>`}
</section>`,
  });
}

export function payDonePage({ checkout: c }) {
  const ok = c.status === 'paid';
  return layout({
    title: ok ? 'Payment received' : 'Payment not made', bare: true, entityName: c.entity_name,
    body: html`<section class="card message"><h1>${ok ? 'Thank you!' : 'No payment was made'}</h1>
  <p>${ok ? `${c.entity_name} received your payment of ${formatCents(Number(c.charged_cents))} for invoice ${c.doc_number ?? ''}. A receipt is on its way by email.`
    : 'You can go back to the link in your email to try again.'}</p></section>`,
  });
}

export function paymentsSettingsBody({ csrf, v, hasKey, error = null }) {
  return html`<form method="post" action="/settings/payments" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <p class="muted">With online payments on, each invoice you email includes a one-time “Pay now” link. When the customer pays, the payment is
    recorded into Undeposited Funds and applied to the invoice, the processor’s fee goes to Merchant Fees, and the customer gets a receipt.</p>
  ${checkbox('Let customers pay invoices online', 'enabled', v.enabled)}
  <div class="form-grid">
    ${selectField('Processor', 'processor', Object.entries(PROCESSORS).map(([k, p]) => [k, p.label]), v.processor)}
    ${selectField('Who pays the processing fee', 'feePayer', [['company', 'We do'], ['customer', 'The customer (added to what they pay)']], v.feePayer)}
  </div>
  <fieldset class="choice"><legend>Ways to pay</legend>
    ${checkbox('Credit and debit cards', 'card', v.card)}
    ${checkbox('Bank transfer (ACH)', 'ach', v.ach)}
  </fieldset>
  <p class="muted small">Stripe or Square will be added once you choose one; until then only the test processor works and no real money moves.
    ${hasKey ? '' : 'The server needs SETTINGS_KEY before payments can be turned on.'}</p>
  <div class="form-actions"><button class="primary">Save payment settings</button></div>
</form>`;
}
