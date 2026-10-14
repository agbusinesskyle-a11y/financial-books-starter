import { HttpError } from './http.js';
import { isPractice } from '../../lib/domain/practice.js';
import { ValidationError } from '../../lib/data/writes.js';
import { settingsKey } from '../../lib/secrets.js';
import { canAccess } from '../../lib/domain/roles.js';
import { getSmsSettings, saveSmsSettings, listSenders, saveSender, deleteSender, saveNicknames, twiml } from '../../lib/sms/twilio.js';
import { handleInbound, listReceipts, receiptCounts, getReceipt, assignAndRetry, rejectReceipt, settleReviewed } from '../../lib/sms/receipts.js';
import { receiptsPage, textReceiptsSettings } from '../../lib/views/receipts.js';

// Text-a-receipt (stage B8).

// Twilio's webhook: public, trusted only with a valid signature over APP_BASE_URL + /twilio/sms.
export async function publicSms({ req, res, pool, env, send, readForm, smsFetch, aiFetch }) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const base = String(env.APP_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) throw new HttpError(503, 'APP_BASE_URL isn’t set, so texts can’t be checked.');
  const params = await readForm(req);
  const out = await handleInbound(pool, { params, url: `${base}/twilio/sms`, signature: req.headers['x-twilio-signature'], key: settingsKey(env), fetchImpl: smsFetch, aiFetch, env });
  // A practice copy texts nobody, not even a reply to a receipt (the reply is kept on the receipt).
  send(res, out.status, out.status === 200 ? twiml(isPractice(env) ? '' : out.reply) : '', { 'Content-Type': out.status === 200 ? 'text/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
}

export async function receiptRoutes(h) {
  const { req, res, path, query, form, pool, page, base, go, takeFlash, ctx, scope, actor, who, env, send, extra } = h;
  if (path === '/settings/text-receipts' || path.startsWith('/settings/text-receipts/')) return settingsRoutes(h);
  if (path !== '/receipts' && !path.startsWith('/receipts/')) return false;
  const canReview = canAccess(who.role, 'POST', '/receipts/1/reject');

  if (path === '/receipts') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    await settleReviewed(pool, scope);
    const tab = ['review', 'waiting', 'added', 'all'].includes(query.tab) ? query.tab : 'review';
    const s = await getSmsSettings(pool, scope);
    page(receiptsPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, tab, receipts: await listReceipts(pool, { ...scope, tab }),
      counts: await receiptCounts(pool, scope), canReview, smsOn: s.enabled, canSetUp: ctx.orgAdmin }));
    return true;
  }
  const m = /^\/receipts\/(\d{1,18})\/(image|assign|reject)$/.exec(path);
  if (!m) throw new HttpError(404, 'Not found');
  const r = await getReceipt(pool, { ...scope, receiptId: m[1] }) ?? (() => { throw new HttpError(404, 'Receipt not found'); })();
  if (m[2] === 'image') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    send(res, 200, r.content, { ...extra, 'Content-Type': r.content_type, 'Content-Disposition': `inline; filename="${r.filename ?? 'receipt'}"`, 'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff' });
    return true;
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!canReview) throw new HttpError(403, 'Only people who keep the books can do that.');
  try {
    if (m[2] === 'reject') {
      await rejectReceipt(pool, { ...scope, receiptId: r.receipt_id, actor });
      return go('/receipts', 'ok', 'Receipt rejected.') ?? true;
    }
    const out = await assignAndRetry(pool, { ...scope, receiptId: r.receipt_id, actor });
    return go(`/receipts?tab=${out.status === 'added' ? 'added' : out.status === 'waiting' ? 'waiting' : 'review'}`, 'ok', out.reply) ?? true;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return go('/receipts', 'error', error.message) ?? true;
  }
}

// Settings → Text receipts (organization-level admins: the Twilio account is the organization's).
async function settingsRoutes(h) {
  const { req, path, form, pool, page, base, go, takeFlash, ctx, actor, env } = h;
  if (!ctx.orgAdmin) throw new HttpError(403, 'Only an admin who can open every company manages text receipts.');
  const org = { orgId: ctx.orgId };
  const companies = async () => (await pool.query(`SELECT e.entity_id, e.name, coalesce((SELECT array_agg(n.nickname ORDER BY n.nickname) FROM company_nickname n
      WHERE n.entity_id = e.entity_id), '{}') AS nicknames FROM entity e WHERE e.org_id = $1 ORDER BY lower(e.name)`, [ctx.orgId]))
    .rows.map(r => ({ entityId: Number(r.entity_id), name: r.name, nicknames: r.nicknames }));
  const show = async (error = null, v = null, status = 200) => {
    page(textReceiptsSettings({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, s: await getSmsSettings(pool, org), senders: await listSenders(pool, org),
      companies: await companies(), webhookUrl: `${String(env.APP_BASE_URL ?? 'https://your-books-address').replace(/\/$/, '')}/twilio/sms`, error, v }), status);
    return true;
  };
  if (req.method === 'GET' && path === '/settings/text-receipts') return show();
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const del = /^\/settings\/text-receipts\/senders\/(\d{1,18})\/delete$/.exec(path);
  try {
    if (del) {
      await deleteSender(pool, { ...org, senderId: del[1] });
      return go('/settings/text-receipts', 'ok', 'Removed.') ?? true;
    }
    if (path === '/settings/text-receipts/senders') {
      await saveSender(pool, { ...org, name: form.get('name'), phone: form.get('phone'), allCompanies: form.get('allCompanies') === '1',
        entityIds: form.getAll('company'), actor });
      return go('/settings/text-receipts', 'ok', `${String(form.get('name')).trim()} can text receipts now.`) ?? true;
    }
    if (path !== '/settings/text-receipts') throw new HttpError(404, 'Not found');
    if (form.get('section') === 'nicknames') {
      const byEntity = Object.fromEntries((await companies()).map(c => [c.entityId, form.get(`nick_${c.entityId}`) ?? '']));
      await saveNicknames(pool, { ...org, byEntity });
      return go('/settings/text-receipts', 'ok', 'Nicknames saved.') ?? true;
    }
    const v = { enabled: form.get('enabled') === '1', accountSid: form.get('accountSid') ?? '', phone: form.get('phone') ?? '' };
    try {
      await saveSmsSettings(pool, { ...org, ...v, authToken: form.get('authToken') ?? '', key: settingsKey(env), actor });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return show(error.message, v, 422);
    }
    return go('/settings/text-receipts', 'ok', v.enabled ? 'Text receipts are on.' : 'Saved.') ?? true;
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return show(error.message, null, 422);
  }
}
