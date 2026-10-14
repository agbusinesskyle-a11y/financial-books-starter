import { HttpError, tooMany, clientIp } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { settingsKey } from '../../lib/secrets.js';
import { PROCESSORS, webhookSecret, testProcessorAllowed } from '../../lib/payments/processors.js';
import {
  getPaymentsSettings, savePaymentsSettings, findPayLink, quote, openCheckout, getCheckout, handleCheckoutEvent,
} from '../../lib/data/online-payments.js';
import { sendTransaction } from '../../lib/data/messages.js';
import { payPage, testCheckoutPage, payDonePage, paymentsSettingsBody } from '../../lib/views/pay.js';
import { publicMessage } from '../../lib/views/vendor-auto.js';

const HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };

// Settings → Payments (admins only, by role).
export async function paymentsSettingsRoutes(h) {
  const { req, path, form, scope, pool, env, go, settingsPage, base } = h;
  if (path !== '/settings/payments') return false;
  const current = await getPaymentsSettings(pool, scope);
  const hasKey = Boolean(settingsKey(env));
  if (req.method === 'GET') { settingsPage('payments', paymentsSettingsBody({ csrf: base().csrf, v: current, hasKey })); return true; }
  const v = { enabled: form.get('enabled') === '1', processor: form.get('processor') ?? 'test', card: form.get('card') === '1', ach: form.get('ach') === '1',
    feePayer: form.get('feePayer') ?? 'company' };
  try {
    await savePaymentsSettings(pool, { ...scope, fields: v, hasKey, env });
    go('/settings/payments', 'ok', v.enabled ? 'Online payments are on. Invoices you email now include a “Pay now” link.' : 'Payment settings saved.');
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    settingsPage('payments', paymentsSettingsBody({ csrf: base().csrf, v, hasKey, error: error.message }), 422, null);
  }
  return true;
}

// The pages a customer sees (no sign-in) and the processor's webhook.
export async function publicPay({ req, res, path, pool, env, send, readForm, now, mailerFor }) {
  const origin = env.APP_BASE_URL ? env.APP_BASE_URL.replace(/\/$/, '') : `http://${req.headers.host ?? '127.0.0.1'}`;
  const secret = webhookSecret(settingsKey(env));
  const html = (status, body, more = {}) => send(res, status, String(body), { ...HEADERS, ...more });
  const notActive = () => html(404, publicMessage({ title: 'This payment link isn’t active', message: 'It was replaced by a newer email, or the invoice was changed. Contact the business for a new link.' }));
  const limited = () => {
    const t = now().getTime();
    if (tooMany(`pay-ip:${clientIp(req, env)}`, 30, t)) throw new HttpError(429, 'Too many tries. Wait a few minutes and try again.');
  };

  // Records a processor event and, once, emails the customer a receipt.
  async function record(checkoutId, status) {
    const result = await handleCheckoutEvent(pool, { checkoutId, status, now: now() });
    if (result.recorded) {
      const c = await getCheckout(pool, { checkoutId });
      const { rows: [t] } = await pool.query('SELECT org_id, entity_id FROM txn WHERE txn_id = $1', [result.paymentTxnId]);
      try {
        await sendTransaction(pool, await mailerFor({ orgId: t.org_id, entityId: t.entity_id }), { orgId: t.org_id, entityId: t.entity_id, txnId: result.paymentTxnId,
          actor: 'online payment' });
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error; // no email on file: the payment stands, no receipt
      }
      return c;
    }
    return null;
  }

  // ---- webhook: POST /webhooks/payments/<processor>, body JSON { type, checkout_id }, header x-fb-signature ----
  let m = /^\/webhooks\/payments\/(test|stripe|square)$/.exec(path);
  if (m) {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const processor = PROCESSORS[m[1]];
    const raw = await rawBody(req);
    if (!secret || !processor.connected || !processor.verify(raw, req.headers['x-fb-signature'], secret)) {
      send(res, 400, 'bad signature', { ...HEADERS, 'Content-Type': 'text/plain' });
      return;
    }
    let event;
    try { event = JSON.parse(raw); } catch { send(res, 400, 'bad body', { ...HEADERS, 'Content-Type': 'text/plain' }); return; }
    const status = { 'checkout.paid': 'paid', 'checkout.canceled': 'canceled', 'checkout.failed': 'failed' }[event.type];
    if (!status || !(await getCheckout(pool, { checkoutId: event.checkout_id }))) { send(res, 400, 'unknown event', { ...HEADERS, 'Content-Type': 'text/plain' }); return; }
    await record(event.checkout_id, status);
    send(res, 200, 'ok', { ...HEADERS, 'Content-Type': 'text/plain' });
    return;
  }

  // ---- the test processor's checkout page (stands in for Stripe/Square's hosted page) ----
  m = /^\/pay\/test-checkout\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (m) {
    if (!testProcessorAllowed(env)) throw new HttpError(404, 'Not found');
    const c = await getCheckout(pool, { checkoutId: m[1] });
    if (!c || c.processor !== 'test') throw new HttpError(404, 'Not found');
    if (req.method === 'GET') { html(200, testCheckoutPage({ checkout: c })); return; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    limited();
    const action = String((await readForm(req)).get('action') ?? '');
    if (c.status === 'open') {
      // The test processor tells the app what happened the same way a real one would: a signed webhook.
      const body = JSON.stringify({ type: action === 'pay' ? 'checkout.paid' : 'checkout.canceled', checkout_id: c.checkout_id });
      await deliverWebhook(body, PROCESSORS.test.sign(body, secret));
    }
    send(res, 303, '', { ...HEADERS, Location: `/pay/done/${c.checkout_id}` });
    return;
  }

  m = /^\/pay\/done\/([A-Za-z0-9_-]{1,40})$/.exec(path);
  if (m) {
    const c = await getCheckout(pool, { checkoutId: m[1] });
    if (!c) throw new HttpError(404, 'Not found');
    html(200, payDonePage({ checkout: c }));
    return;
  }

  // ---- the customer's pay page: GET shows the invoice and choices; POST opens a checkout ----
  m = /^\/pay\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const link = await findPayLink(pool, { token: m[1] });
  if (!link) { notActive(); return; }
  const balance = Number(link.open_cents);
  const quotes = Object.fromEntries(['card', 'ach'].filter(k => link.settings[k]).map(k => [k, quote(link.settings, balance, k)]));
  if (req.method === 'GET') { html(200, payPage({ link, quotes })); return; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  limited();
  const method = String((await readForm(req)).get('method') ?? '');
  try {
    const { url } = await openCheckout(pool, { token: m[1], method, origin });
    send(res, 303, '', { ...HEADERS, Location: url });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    html(422, payPage({ link, quotes, error: error.message }));
  }

  // The test processor posts its webhook straight to this app's own handler (no network hop needed for a fake processor).
  async function deliverWebhook(body, signature) {
    if (!secret) throw new HttpError(503, 'Payments aren’t set up on this server.');
    if (!PROCESSORS.test.verify(body, signature, secret)) throw new HttpError(500, 'Signature mismatch.');
    const event = JSON.parse(body);
    await record(event.checkout_id, event.type === 'checkout.paid' ? 'paid' : 'canceled');
  }
}

async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
