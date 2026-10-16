import { settingsKey } from '../../lib/secrets.js';
import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { getLink, linkChoices, linkCompany, unlinkCompany, listFeedAccounts, recentPulls, mappingChoices, saveMappings } from '../../lib/data/bankfeeds.js';
import { pullCompany } from '../../lib/bankfeed/pull.js';
import { bankFeedsPage } from '../../lib/views/bankfeeds.js';
import { canAccess } from '../../lib/domain/roles.js';

// Bank connections (stage B2): Settings → Bank connections (admins) and the Refresh button (anyone who keeps the books).
export async function bankFeedRoutes(h) {
  const { req, path, form, pool, page, base, go, takeFlash, ctx, scope, actor, who, ledgerline: ll } = h;
  const summary = r => (r.status === 'ok'
    ? ['ok', `Bank feed refreshed: ${r.new} new, ${r.updated} updated, ${r.removed} removed.${r.warning ? ` ${r.warning}` : ''}`]
    : ['error', `Bank feed not refreshed: ${r.error}`]);

  if (path === '/bank-feeds/refresh') {
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const asked = String(form.get('back') ?? '');
    const back = /^\/banking(\?[\w=&%.-]*)?$/.test(asked) ? asked : canAccess(who.role, 'GET', '/settings/bank-feeds') ? '/settings/bank-feeds' : '/banking';
    try {
      const [kind, text] = summary(await pullCompany(pool, ll, { ...scope, trigger: 'refresh', key: settingsKey(h.env), smsFetch: h.smsFetch, env: h.env, research: 'background', aiFetch: h.aiFetch }));
      return go(back, kind, text) ?? true;
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return go(back, 'error', error.message) ?? true;
    }
  }
  if (!path.startsWith('/settings/bank-feeds')) return false;

  const show = async (error = null, status = 200) => {
    const link = ll ? await getLink(pool, scope) : null;
    let choices = [];
    if (ll && !link) {
      try { choices = await linkChoices(pool, ll, scope); } catch { error = error ?? 'Couldn’t reach ledgerline to list its companies. Try again in a minute.'; }
    }
    const accounts = link ? await listFeedAccounts(pool, scope) : [];
    const mapping = link ? await mappingChoices(pool, { ...scope, feedAccounts: accounts }) : new Map();
    page(bankFeedsPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, connected: Boolean(ll), link, choices, accounts, mapping,
      pulls: link ? await recentPulls(pool, scope) : [], error }), status);
    return true;
  };
  const attempt = async fn => {
    try { return await fn(); } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return show(error.message, 422);
    }
  };

  if (path === '/settings/bank-feeds') {
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
    return show();
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  if (!ll) throw new HttpError(404, 'Ledgerline isn’t connected');
  if (path === '/settings/bank-feeds/link') {
    return attempt(async () => {
      const choice = await linkCompany(pool, ll, { ...scope, llEntityId: form.get('ll_entity_id'), actor });
      const r = await pullCompany(pool, ll, { ...scope, trigger: 'link', key: settingsKey(h.env), smsFetch: h.smsFetch, env: h.env, research: 'background', aiFetch: h.aiFetch });
      return go('/settings/bank-feeds', r.status === 'ok' ? 'ok' : 'error', r.status === 'ok'
        ? `Linked to ${choice.name}. Match each account below to an account in these books.` : `Linked to ${choice.name}, but ${r.error}`) ?? true;
    });
  }
  if (path === '/settings/bank-feeds/unlink') {
    return attempt(async () => {
      await unlinkCompany(pool, scope);
      return go('/settings/bank-feeds', 'ok', 'Unlinked from ledgerline.') ?? true;
    });
  }
  if (path === '/settings/bank-feeds/accounts') {
    return attempt(async () => {
      const choices = form.getAll('account').map(id => ({ id, choice: form.get(`books_${id}`) ?? '', start: form.get(`start_${id}`) ?? '' }));
      await saveMappings(pool, { ...scope, choices, actor });
      const [kind, text] = summary(await pullCompany(pool, ll, { ...scope, trigger: 'refresh', key: settingsKey(h.env), smsFetch: h.smsFetch, env: h.env, research: 'background', aiFetch: h.aiFetch }));
      return go('/settings/bank-feeds', kind, `Accounts saved. ${text}`) ?? true;
    });
  }
  throw new HttpError(404, 'Not found');
}
