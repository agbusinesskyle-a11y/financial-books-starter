import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { multicurrencyOn, turnOnMulticurrency, listCurrencies, addCurrency, addRate, listRates, revalue } from '../../lib/data/currencies.js';
import { currenciesBody } from '../../lib/views/currencies.js';
import { formatCents } from '../../lib/domain/money.js';

// Settings → Currencies (admins only, by role). h: request helpers from index.js.
export async function currencyRoutes(h) {
  const { req, path, form, ctx, scope, pool, go, settingsPage, base, actor } = h;
  if (!path.startsWith('/settings/currencies')) return false;
  const show = async (error = null, status = 200) => {
    const currencies = await listCurrencies(pool, scope);
    const rates = Object.fromEntries(await Promise.all(currencies.map(async c => [c.code, await listRates(pool, { ...scope, code: c.code })])));
    settingsPage('currencies', currenciesBody({ csrf: base().csrf, on: await multicurrencyOn(pool, scope), currencies, rates, today: ctx.today, error }), status,
      error ? null : undefined);
  };
  if (path === '/settings/currencies' && req.method === 'GET') { await show(); return true; }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  try {
    if (path === '/settings/currencies/on') {
      await turnOnMulticurrency(pool, { ...scope, actor });
      go('/settings/currencies', 'ok', 'Multicurrency is on. Add the currencies you use.');
    } else if (path === '/settings/currencies') {
      await addCurrency(pool, { ...scope, code: String(form.get('code') ?? ''), rateText: form.get('rate'), date: String(form.get('date') ?? '') });
      go('/settings/currencies', 'ok', `${form.get('code')} added.`);
    } else if (path === '/settings/currencies/revalue') {
      const r = await revalue(pool, { ...scope, date: String(form.get('date') ?? ''), actor });
      go('/settings/currencies', 'ok', r.txnId ? `Revalued: A/R ${formatCents(r.arCents)}, A/P ${formatCents(r.apCents)} (reverses the next day).` : 'Nothing to revalue: open balances already match the rates.');
    } else {
      const m = /^\/settings\/currencies\/([A-Z]{3})\/rate$/.exec(path);
      if (!m) throw new HttpError(404, 'Not found');
      await addRate(pool, { ...scope, code: m[1], rateText: form.get('rate'), date: String(form.get('date') ?? '') });
      go('/settings/currencies', 'ok', `${m[1]} rate saved.`);
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    await show(error.message, 422);
  }
  return true;
}
