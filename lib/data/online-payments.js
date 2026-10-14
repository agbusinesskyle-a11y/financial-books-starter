import { createHash, randomBytes } from 'node:crypto';
import { withTransaction } from '../db.js';
import { ValidationError, lockEntity, logActivity, applyFrom } from './writes.js';
import { repost } from './ledger.js';
import { PROCESSORS, testProcessorAllowed } from '../payments/processors.js';
import { formatCents } from '../domain/money.js';
import { todayIn } from '../domain/dates.js';

// Online invoice payments (Settings → Payments): a "Pay now" link on emailed invoices, a checkout with the processor,
// and a signed webhook that records the payment into Undeposited Funds with the processor's fee in Merchant Fees.

const fail = message => { throw new ValidationError(message); };
const hash = token => createHash('sha256').update(token).digest('hex');

const DEFAULTS = { enabled: false, processor: 'test', card: true, ach: true, feePayer: 'company' };

export async function getPaymentsSettings(db, { orgId, entityId }) {
  const { rows: [r] } = await db.query('SELECT * FROM payments_settings WHERE org_id = $1 AND entity_id = $2', [orgId, entityId]);
  return r ? { enabled: r.enabled, processor: r.processor, card: r.card, ach: r.ach, feePayer: r.fee_payer } : { ...DEFAULTS };
}

export async function savePaymentsSettings(pool, { orgId, entityId, fields: f, hasKey, env = process.env }) {
  const enabled = f.enabled === true || f.enabled === '1';
  const processor = Object.hasOwn(PROCESSORS, f.processor) ? f.processor : 'test';
  if (enabled && !PROCESSORS[processor].connected) fail(`${PROCESSORS[processor].label}. Use the test processor until an account is connected.`);
  if (enabled && processor === 'test' && !testProcessorAllowed(env)) fail('The test processor can’t take payments on a live server. Connect Stripe or Square first.');
  if (enabled && !hasKey) fail('The server has no SETTINGS_KEY, which signs payment notifications. Add SETTINGS_KEY first.');
  const card = f.card === true || f.card === '1', ach = f.ach === true || f.ach === '1';
  if (enabled && !card && !ach) fail('Choose at least one way to pay (card or bank transfer).');
  await pool.query(
    `INSERT INTO payments_settings (org_id, entity_id, enabled, processor, card, ach, fee_payer) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id, entity_id) DO UPDATE SET enabled = $3, processor = $4, card = $5, ach = $6, fee_payer = $7`,
    [orgId, entityId, enabled, processor, card, ach, f.feePayer === 'customer' ? 'customer' : 'company']);
}

// A fresh "Pay now" link for an invoice (older links for it stop working). Returns the token, or null when online
// payments are off or nothing is due.
export async function createPayLink(db, { orgId, entityId, txnId }) {
  const s = await getPaymentsSettings(db, { orgId, entityId });
  if (!s.enabled) return null;
  const { rows: [t] } = await db.query(`SELECT open_cents, voided_at, currency FROM txn WHERE org_id = $1 AND entity_id = $2 AND txn_id = $3 AND type IN ('invoice', 'late_fee')`,
    [orgId, entityId, txnId]);
  // Online payment of foreign-currency invoices isn't offered yet.
  if (!t || t.voided_at || t.currency || Number(t.open_cents) <= 0) return null;
  const token = randomBytes(32).toString('base64url');
  await db.query('UPDATE invoice_pay_link SET replaced_at = now() WHERE txn_id = $1 AND used_at IS NULL AND replaced_at IS NULL', [txnId]);
  await db.query('INSERT INTO invoice_pay_link (org_id, txn_id, token_hash) VALUES ($1,$2,$3)', [orgId, txnId, hash(token)]);
  return token;
}

// What the public payment page shows for a link, or null if the link is unknown or replaced.
export async function findPayLink(db, { token }) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ''))) return null;
  const { rows: [r] } = await db.query(
    `SELECT l.link_id, l.used_at, t.txn_id, t.org_id, t.entity_id, t.doc_number, t.type, t.total_cents, t.open_cents, t.due_date, t.voided_at,
            c.display_name AS customer_name, e.name AS entity_name, e.time_zone
       FROM invoice_pay_link l JOIN txn t ON t.txn_id = l.txn_id JOIN customer c ON c.customer_id = t.customer_id JOIN entity e ON e.entity_id = t.entity_id
      WHERE l.token_hash = $1 AND l.replaced_at IS NULL`, [hash(token)]);
  if (!r) return null;
  return { ...r, settings: await getPaymentsSettings(db, { orgId: r.org_id, entityId: r.entity_id }) };
}

// What a payment of the open balance by `method` costs: { balance, surcharge, charged, fee }.
export function quote(settings, balance, method) {
  const p = PROCESSORS[settings.processor];
  const surcharge = settings.feePayer === 'customer' ? p.fee(balance, method) : 0;
  const charged = balance + surcharge;
  return { balance, surcharge, charged, fee: p.fee(charged, method) };
}

// Opens a checkout for the link's whole open balance. Returns { checkoutId, url }.
export async function openCheckout(pool, { token, method, origin }) {
  const link = await findPayLink(pool, { token }) ?? fail('This payment link isn’t active.');
  const s = link.settings;
  if (!s.enabled) fail('Online payments are turned off. Contact the business to pay.');
  if (link.used_at || link.voided_at || Number(link.open_cents) <= 0) fail('Nothing is due on this invoice.');
  if (!['card', 'ach'].includes(method) || !s[method]) fail('Choose how to pay.');
  const q = quote(s, Number(link.open_cents), method);
  const checkoutId = `co_${randomBytes(18).toString('base64url')}`;
  // One checkout at a time per link: a second tab can't pay the same balance twice. The link row is locked so two
  // requests at the same moment are handled one after the other (and the database allows one open checkout per link).
  await withTransaction(pool, async tx => {
    await tx.query('SELECT 1 FROM invoice_pay_link WHERE link_id = $1 FOR UPDATE', [link.link_id]);
    await tx.query(`UPDATE online_checkout SET status = 'canceled', completed_at = now() WHERE link_id = $1 AND status = 'open'`, [link.link_id]);
    await tx.query(
      `INSERT INTO online_checkout (org_id, checkout_id, link_id, txn_id, processor, method, balance_cents, fee_cents, surcharge_cents, charged_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [link.org_id, checkoutId, link.link_id, link.txn_id, s.processor, method, q.balance, q.fee, q.surcharge, q.charged]);
  });
  return { checkoutId, url: PROCESSORS[s.processor].checkoutUrl(checkoutId, origin) };
}

export async function getCheckout(db, { checkoutId }) {
  if (!/^co_[A-Za-z0-9_-]{24}$/.test(String(checkoutId ?? ''))) return null;
  const { rows: [c] } = await db.query(
    `SELECT o.*, t.doc_number, t.customer_id, c.display_name AS customer_name, e.name AS entity_name FROM online_checkout o JOIN txn t ON t.txn_id = o.txn_id
       JOIN customer c ON c.customer_id = t.customer_id JOIN entity e ON e.entity_id = t.entity_id WHERE o.checkout_id = $1`, [checkoutId]);
  return c ?? null;
}

// The processor said a checkout was paid (or canceled / failed). Idempotent: a repeated event changes nothing.
// Returns { paymentTxnId, recorded } — recorded is false when this event was already handled.
export async function handleCheckoutEvent(pool, { checkoutId, status: reported, now = new Date() }) {
  let status = reported;
  if (!['paid', 'canceled', 'failed'].includes(status)) fail('Unknown event.');
  return withTransaction(pool, async tx => {
    const { rows: [c] } = await tx.query('SELECT o.*, t.entity_id, t.customer_id, t.doc_number FROM online_checkout o JOIN txn t ON t.txn_id = o.txn_id WHERE checkout_id = $1',
      [checkoutId]);
    if (!c) fail('Unknown checkout.');
    await lockEntity(tx, c.org_id, c.entity_id);
    const { rows: [fresh] } = await tx.query('SELECT status, payment_txn_id FROM online_checkout WHERE checkout_id = $1 FOR UPDATE', [checkoutId]);
    if (fresh.status !== 'open') return { paymentTxnId: fresh.payment_txn_id, recorded: false };
    // Payments must still be on with this processor (a real processor's money is still recorded if it already moved).
    const s = await getPaymentsSettings(tx, { orgId: c.org_id, entityId: c.entity_id });
    if (status === 'paid' && c.processor === 'test' && (!s.enabled || s.processor !== 'test')) status = 'failed';
    if (status !== 'paid') {
      await tx.query('UPDATE online_checkout SET status = $2, completed_at = $3 WHERE checkout_id = $1', [checkoutId, status, now]);
      return { paymentTxnId: null, recorded: false };
    }
    const { rows: [e] } = await tx.query('SELECT time_zone FROM entity WHERE entity_id = $1', [c.entity_id]);
    const date = todayIn(e.time_zone, now);
    const balance = Number(c.balance_cents);
    const { rows: [pay] } = await tx.query(
      `INSERT INTO txn (org_id, entity_id, customer_id, type, txn_date, payment_method, payment_ref, memo, total_cents, open_cents, fee_cents, surcharge_cents)
       VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$8,$8,$9,$10) RETURNING *`,
      [c.org_id, c.entity_id, c.customer_id, date, c.method === 'ach' ? 'ACH' : 'Credit card', checkoutId.slice(0, 50),
        `Paid online (${PROCESSORS[c.processor].label.replace(/ \(.*\)$/, '')})`, balance, Number(c.fee_cents), Number(c.surcharge_cents)]);
    await repost(tx, c.org_id, pay.txn_id);
    // Applied to the invoice up to what's still open (it may have been paid another way meanwhile); the rest stays a credit.
    const { rows: [inv] } = await tx.query('SELECT open_cents, voided_at FROM txn WHERE txn_id = $1 FOR UPDATE', [c.txn_id]);
    const apply = inv.voided_at ? 0 : Math.min(balance, Number(inv.open_cents));
    if (apply > 0) {
      await applyFrom(tx, { orgId: c.org_id, credit: pay, applications: [{ chargeTxnId: c.txn_id, amountCents: apply }], appliedOn: date });
      await tx.query('UPDATE txn SET open_cents = open_cents - $2 WHERE txn_id = $1', [pay.txn_id, apply]);
    }
    await tx.query(`UPDATE online_checkout SET status = 'paid', completed_at = $2, payment_txn_id = $3 WHERE checkout_id = $1`, [checkoutId, now, pay.txn_id]);
    await tx.query('UPDATE invoice_pay_link SET used_at = $2 WHERE link_id = $1', [c.link_id, now]);
    await logActivity(tx, { orgId: c.org_id, customerId: c.customer_id, txnId: pay.txn_id, actor: 'online payment', kind: 'payment_received',
      summary: `Paid ${formatCents(balance)} online for invoice ${c.doc_number ?? ''} (fee ${formatCents(Number(c.fee_cents))}${Number(c.surcharge_cents) ? `, customer paid ${formatCents(Number(c.surcharge_cents))} fee` : ''})` });
    return { paymentTxnId: pay.txn_id, recorded: true };
  });
}
