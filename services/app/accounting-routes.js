import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { accountsOfTypes } from '../../lib/data/ledger.js';
import {
  getAccountingSettings, saveAccountingSettings, listClasses, saveClass, listLocations, saveLocation, listTags, listTagGroups, saveTag, deleteTag,
} from '../../lib/data/accounting.js';
import { accountingSettingsBody, accountingToValues, accountingFormValues, classesBody, locationsBody, tagsBody } from '../../lib/views/accounting.js';

// Settings → Accounting, Classes, Locations, Tags. h: the request helpers from index.js.
export async function accountingRoutes(h) {
  const { req, path, form, scope, pool, go, settingsPage, base } = h;
  const csrf = base().csrf;
  const tryOr = async (fn, onError) => {
    try { await fn(); } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      await onError(error.message);
    }
    return true;
  };

  if (path === '/settings/accounting') {
    const incomeAccounts = await accountsOfTypes(pool, { ...scope, types: ['income', 'other_income'] });
    if (req.method === 'GET') {
      settingsPage('accounting', accountingSettingsBody({ csrf, incomeAccounts, v: accountingToValues(await getAccountingSettings(pool, scope)) }));
      return true;
    }
    const v = accountingFormValues(form);
    return tryOr(async () => { await saveAccountingSettings(pool, { ...scope, fields: v }); go('/settings/accounting', 'ok', 'Accounting settings saved.'); },
      error => settingsPage('accounting', accountingSettingsBody({ csrf, incomeAccounts, v, error }), 422, null));
  }

  let m = /^\/settings\/classes(?:\/(\d{1,18}))?$/.exec(path);
  if (m) {
    const show = async (more = {}, status = 200) => settingsPage('classes', classesBody({ csrf, classes: await listClasses(pool, scope),
      on: (await getAccountingSettings(pool, scope)).classesOn, ...more }), status, more.error ? null : undefined);
    if (req.method === 'GET' && !m[1]) { await show(); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const v = { name: form.get('name') ?? '', parentId: form.get('parentId') ?? '', active: m[1] ? form.get('active') === '1' : true };
    return tryOr(async () => {
      await saveClass(pool, { ...scope, classId: m[1] ? Number(m[1]) : null, fields: v });
      go('/settings/classes', 'ok', m[1] ? 'Class updated.' : `Class “${v.name.trim()}” added.`);
    }, error => show({ v, error }, 422));
  }

  m = /^\/settings\/locations(?:\/(\d{1,18}))?$/.exec(path);
  if (m) {
    const settings = await getAccountingSettings(pool, scope);
    const show = async (more = {}, status = 200) => settingsPage('locations', locationsBody({ csrf, locations: await listLocations(pool, scope),
      on: settings.locationsOn, label: settings.locationLabel, ...more }), status, more.error ? null : undefined);
    if (req.method === 'GET' && !m[1]) { await show(); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    const v = { name: form.get('name') ?? '', active: m[1] ? form.get('active') === '1' : true };
    return tryOr(async () => {
      await saveLocation(pool, { ...scope, locationId: m[1] ? Number(m[1]) : null, fields: v });
      go('/settings/locations', 'ok', 'Saved.');
    }, error => show({ v, error }, 422));
  }

  m = /^\/settings\/tags(?:\/(\d{1,18})\/delete)?$/.exec(path);
  if (m) {
    const show = async (more = {}, status = 200) => settingsPage('tags', tagsBody({ csrf, tags: await listTags(pool, scope), groups: await listTagGroups(pool, scope), ...more }),
      status, more.error ? null : undefined);
    if (req.method === 'GET' && !m[1]) { await show(); return true; }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
    if (m[1]) { await deleteTag(pool, { ...scope, tagId: Number(m[1]) }); go('/settings/tags', 'ok', 'Tag deleted.'); return true; }
    const v = { name: form.get('name') ?? '', groupId: form.get('groupId') ?? '', newGroup: form.get('newGroup') ?? '' };
    return tryOr(async () => { await saveTag(pool, { ...scope, fields: v }); go('/settings/tags', 'ok', `Tag “${v.name.trim()}” added.`); },
      error => show({ v, error }, 422));
  }
  return false;
}
