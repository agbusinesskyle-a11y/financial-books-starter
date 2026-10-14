import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { settingsKey } from '../../lib/secrets.js';
import { getAiSettings, saveAiSettings, aiUsage, JOBS } from '../../lib/ai/provider.js';
import { aiSettingsPage } from '../../lib/views/ai.js';

// Settings → AI (stage B5). The key is the organization's, so only organization-level admins change it.
export async function aiRoutes(h) {
  const { req, path, form, pool, page, base, go, takeFlash, ctx, actor, env } = h;
  if (path !== '/settings/ai') return false;
  if (!ctx.orgAdmin) throw new HttpError(403, 'Only an admin who can open every company manages AI.');
  const show = async (v = null, error = null, status = 200) => {
    page(aiSettingsPage({ ...base(), flash: takeFlash(), timeZone: ctx.timeZone, s: await getAiSettings(pool, { orgId: ctx.orgId }),
      usage: await aiUsage(pool, { orgId: ctx.orgId }), v, error, hasSettingsKey: Boolean(env.SETTINGS_KEY) }), status);
    return true;
  };
  if (req.method === 'GET') return show();
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const v = { provider: form.get('provider') ?? 'off', webSearch: form.get('webSearch') === '1',
    models: Object.fromEntries(Object.keys(JOBS).map(j => [j, form.get(`model_${j}`) ?? ''])) };
  try {
    await saveAiSettings(pool, { orgId: ctx.orgId, ...v, apiKey: form.get('apiKey') ?? '', key: settingsKey(env), actor });
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return show(v, error.message, 422);
  }
  return go('/settings/ai', 'ok', v.provider === 'off' ? 'AI is off.' : 'AI settings saved.') ?? true;
}
