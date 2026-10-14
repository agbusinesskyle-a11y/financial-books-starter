import { createHmac, timingSafeEqual } from 'node:crypto';

// Card / bank payment processors behind one small interface, so Stripe or Square can be added without touching the rest:
//   fee(amountCents, method) -> the processor's fee
//   checkoutUrl(checkoutId, origin) -> where to send the customer to pay
//   sign(payload, secret) / verify(rawBody, signature, secret) -> webhook signatures (HMAC-SHA256 here)
// Only the built-in test processor moves no real money; it is the only one available until a real account is connected.

const hmac = (body, secret) => createHmac('sha256', secret).update(body).digest('hex');

export const PROCESSORS = {
  test: {
    label: 'Test processor (no real money)',
    connected: true,
    fee(amountCents, method) {
      return method === 'ach' ? Math.min(500, Math.round(amountCents * 0.008)) : Math.round(amountCents * 0.029) + 30;
    },
    checkoutUrl: (checkoutId, origin = '') => `${origin}/pay/test-checkout/${checkoutId}`,
    sign: (body, secret) => hmac(body, secret),
    verify(rawBody, signature, secret) {
      const want = Buffer.from(hmac(rawBody, secret)), got = Buffer.from(String(signature ?? ''));
      return want.length === got.length && timingSafeEqual(want, got);
    },
  },
  stripe: { label: 'Stripe (not connected yet)', connected: false },
  square: { label: 'Square (not connected yet)', connected: false },
};

// The test processor lets anyone "pay" without money moving, so it's refused in production unless PAYMENTS_TEST_MODE=1.
export const testProcessorAllowed = env => env.NODE_ENV !== 'production' || env.PAYMENTS_TEST_MODE === '1';

// The webhook signing secret, derived from SETTINGS_KEY so nothing extra has to be configured for the test processor.
export const webhookSecret = key => (key ? createHmac('sha256', key).update('financial-books payments webhook v1').digest('hex') : null);
