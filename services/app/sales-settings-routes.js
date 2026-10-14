import { HttpError } from './http.js';
import { ValidationError, listTerms } from '../../lib/data/writes.js';
import {
  getSalesSettings, saveSalesSettings, saveMessageSettings, getFormStyle, saveFormStyle, parseFormStyle,
} from '../../lib/data/sales-settings.js';
import { getEntity } from '../../lib/data/messages.js';
import { listRules, getRule, saveRule, deleteRule } from '../../lib/data/price-rules.js';
import { priceRulesBody, ruleFormBody, ruleToValues, ruleFormValues, NEW_RULE } from '../../lib/views/price-rules.js';
import { renderTransactionsPdf } from '../../lib/pdf/transaction.js';
import { addDays } from '../../lib/domain/dates.js';
import {
  salesSettingsBody, salesToValues, salesFormValues, messagesSettingsBody, messagesToValues, messagesFormValues, messagesFields,
  formStylesBody, styleToValues, styleFormValues,
} from '../../lib/views/sales-settings.js';

// Settings → Sales, Messages and reminders, Form styles. h: the request helpers from index.js.
export async function salesSettingsRoutes(h) {
  const { req, path, form, ctx, scope, pool, go, settingsPage, base, send, res, extra } = h;
  const csrf = base().csrf;
  const attemptSave = async (back, tab, save, show) => {
    try {
      await save();
      go(back, 'ok', 'Settings saved.');
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await show(error.message);
    }
    return true;
  };

  if (path === '/settings/sales') {
    const terms = await listTerms(pool, scope);
    if (req.method === 'GET') { settingsPage('sales', salesSettingsBody({ csrf, terms, v: salesToValues(await getSalesSettings(pool, scope)) })); return true; }
    const v = salesFormValues(form);
    return attemptSave('/settings/sales', 'sales', () => saveSalesSettings(pool, { ...scope, fields: v }),
      error => settingsPage('sales', salesSettingsBody({ csrf, terms, v, error }), 422, null));
  }

  if (path === '/settings/messages') {
    const current = await getSalesSettings(pool, scope);
    if (req.method === 'GET') {
      settingsPage('messages', messagesSettingsBody({ csrf, v: messagesToValues(current), remindersFrom: current.remindersOn ? current.remindersFrom : null }));
      return true;
    }
    const v = messagesFormValues(form);
    return attemptSave('/settings/messages', 'messages', () => saveMessageSettings(pool, { ...scope, fields: messagesFields(v), today: ctx.today, current }),
      error => settingsPage('messages', messagesSettingsBody({ csrf, v, remindersFrom: null, error }), 422, null));
  }

  if (path.startsWith('/settings/price-rules')) {
    const m = /^\/settings\/price-rules(?:\/(new|\d{1,18}))?(\/delete)?$/.exec(path);
    if (!m) throw new HttpError(404, 'Not found');
    if (!m[1] && req.method === 'GET') { settingsPage('price-rules', priceRulesBody({ rules: await listRules(pool, scope) })); return true; }
    const ruleId = m[1] && m[1] !== 'new' ? Number(m[1]) : null;
    const rule = ruleId ? await getRule(pool, { ...scope, ruleId }) : null;
    if (ruleId && !rule) throw new HttpError(404, 'Price rule not found');
    // Active ones, plus any the rule already names (so saving doesn't drop them).
    const [customers, items] = await Promise.all([
      pool.query('SELECT customer_id, display_name FROM customer WHERE org_id = $1 AND entity_id = $2 AND (active OR customer_id = ANY($3::bigint[])) ORDER BY display_name',
        [ctx.orgId, ctx.entityId, rule?.customer_ids ?? []]),
      pool.query('SELECT item_id, name FROM item WHERE org_id = $1 AND entity_id = $2 AND (active OR item_id = ANY($3::bigint[])) ORDER BY name',
        [ctx.orgId, ctx.entityId, rule?.item_ids ?? []])]);
    const show = (v, error = null, status = 200) => settingsPage('price-rules', ruleFormBody({ csrf, ruleId, v, customers: customers.rows, items: items.rows, error }), status, error ? null : undefined);
    if (req.method === 'GET') {
      if (m[2]) throw new HttpError(405, 'Method not allowed');
      show(rule ? ruleToValues(rule) : NEW_RULE);
      return true;
    }
    if (m[2]) {
      if (!rule) throw new HttpError(404, 'Not found');
      await deleteRule(pool, { ...scope, ruleId });
      go('/settings/price-rules', 'ok', `“${rule.name}” deleted.`);
      return true;
    }
    if (m[1] === 'new') throw new HttpError(404, 'Not found');
    const v = ruleFormValues(form);
    try {
      await saveRule(pool, { ...scope, ruleId, fields: v });
      go('/settings/price-rules', 'ok', `“${v.name.trim()}” saved.`);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      show(v, error.message, 422);
    }
    return true;
  }

  if (path === '/settings/form-styles' || path === '/settings/form-styles/preview.pdf') {
    const entity = await getEntity(pool, scope);
    const hasLogo = Boolean((await pool.query('SELECT 1 FROM entity WHERE entity_id = $1 AND logo IS NOT NULL', [ctx.entityId])).rowCount);
    if (path.endsWith('.pdf')) {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      let style;
      try { style = parseFormStyle(rawStyle(form)); } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        throw new HttpError(400, error.message);
      }
      const logo = style.showLogo ? (await pool.query('SELECT logo FROM entity WHERE entity_id = $1', [ctx.entityId])).rows[0].logo : null;
      const pdf = await renderTransactionsPdf({ entity: { ...entity, style, logo }, txns: [sampleInvoice(ctx.today)] });
      send(res, 200, pdf, { ...extra, 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="form-style-preview.pdf"' });
      return true;
    }
    if (req.method === 'GET') { settingsPage('form-styles', formStylesBody({ csrf, hasLogo, v: styleToValues(await getFormStyle(pool, scope)) })); return true; }
    const v = styleFormValues(form);
    return attemptSave('/settings/form-styles', 'form-styles', () => saveFormStyle(pool, { ...scope, fields: rawStyle(form) }),
      error => settingsPage('form-styles', formStylesBody({ csrf, hasLogo, v, error }), 422, null));
  }
  return false;
}

// The form-style fields as strings, the way parseFormStyle reads them.
const rawStyle = form => Object.fromEntries(['showLogo', 'accent', 'font', 'showTerms', 'showDueDate', 'showProject', 'showServiceDate', 'showMessage', 'footer']
  .map(k => [k, form.get(k) ?? '']));

// A made-up invoice for the preview (never saved).
function sampleInvoice(today) {
  return {
    txn_id: 0, type: 'invoice', doc_number: 'INV-1001', txn_date: today, due_date: addDays(today, 30), terms_name: 'Net 30', project_name: 'Spring planting',
    total_cents: 54250, open_cents: 54250, discount_cents: 2750, discount_percent: 5, shipping_cents: 2000, memo: 'Thank you for your order.',
    customer: { display_name: 'Sample Customer', billing_address: { line1: '12 County Rd', city: 'Gainesville', state: 'TX', postal: '76240' } },
    lines: [
      { line_no: 1, item_name: 'Layer Pellets 50 lb', description: 'Layer Pellets 50 lb', quantity: 20, rate_cents: 1850, amount_cents: 37000, service_date: today },
      { line_no: 2, item_name: 'Delivery', description: 'Delivery', quantity: 1, rate_cents: 18000, amount_cents: 18000, service_date: today },
    ],
    applications: [],
  };
}
