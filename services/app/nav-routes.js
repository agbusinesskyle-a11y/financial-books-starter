import { HttpError } from './http.js';
import { ValidationError } from '../../lib/data/writes.js';
import { canAccess } from '../../lib/domain/roles.js';
import { appNav, SOON } from '../../lib/views/nav.js';
import { addBookmark, removeBookmark, moveBookmarkUp, savePins, cleanHref } from '../../lib/data/nav.js';
import { homeData } from '../../lib/data/home.js';
import { globalSearch } from '../../lib/data/search.js';
import { homePage, appsPage, createPage, bookmarksPage, navigationPage, soonPage, searchPage } from '../../lib/views/nav-pages.js';

// The navigation's own pages (stage N1/N2): /home, /apps, /create, /bookmarks, /navigation, /soon/:slug, /search.
const PATHS = /^\/(home|apps|create|search|navigation|bookmarks(\/(add|remove|up))?|soon\/[a-z0-9-]+)$/;

export async function navRoutes(h) {
  const { req, res, path, query, form, scope, pool, page, base, go, takeFlash, who, ctx, navData, send, extra } = h;
  if (!PATHS.test(path)) return false;
  // The same as the sidebar's: people limited to some companies don't manage users or companies.
  const can = p => canAccess(who.role, 'GET', p) && (ctx.orgAdmin || !/^\/settings\/(users|companies)(\/|$)/.test(p));
  const nav = () => appNav({ ...navData, role: who.role, can, path, search: '', title: '', csrf: base().csrf, entityName: ctx.entityName });

  if (req.method === 'GET') {
    if (path === '/home') {
      page(homePage({ ...base(), flash: takeFlash(), data: await homeData(pool, { ...scope, today: ctx.today }),
        quick: nav().create.flatMap(([, items]) => items.filter(i => i.href)).slice(0, 12) }));
      return true;
    }
    if (path === '/apps') { const n = nav(); page(appsPage({ ...base(), groups: n.groups, reports: n.reports })); return true; }
    if (path === '/create') { page(createPage({ ...base(), create: nav().create })); return true; }
    if (path === '/bookmarks') { page(bookmarksPage({ ...base(), flash: takeFlash(), bookmarks: navData.bookmarks })); return true; }
    if (path === '/navigation') { page(navigationPage({ ...base(), flash: takeFlash(), pins: navData.pins })); return true; }
    if (path.startsWith('/soon/')) {
      const slug = path.slice(6);
      // Lending's placeholders became the Loans page; a bookmark saved on one still gets there.
      if (['lending', 'loans', 'line-of-credit'].includes(slug)) return go('/loans') ?? true;
      if (!Object.hasOwn(SOON, slug)) throw new HttpError(404, 'Not found');
      page(soonPage({ ...base(), slug }));
      return true;
    }
    if (path === '/search') {
      const result = await globalSearch(pool, { ...scope, q: query.q, can, limit: query.format === 'json' ? 5 : 15 });
      if (query.format === 'json') {
        send(res, 200, JSON.stringify(result), { ...extra, 'Content-Type': 'application/json; charset=utf-8' });
        return true;
      }
      page(searchPage({ ...base(), result }));
      return true;
    }
    throw new HttpError(405, 'Method not allowed');
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

  const backTo = (fallback = '/bookmarks') => cleanHref(form.get('back')) ?? cleanHref(form.get('href')) ?? fallback;
  try {
    if (path === '/bookmarks/add') {
      const href = await addBookmark(pool, { ...scope, who, href: form.get('href'), label: form.get('label') });
      return go(href, 'ok', 'Bookmarked. It’s under Bookmarks on the left.') ?? true;
    }
    if (path === '/bookmarks/remove') {
      await removeBookmark(pool, { ...scope, who, href: form.get('href') });
      return go(backTo(), 'ok', 'Bookmark removed.') ?? true;
    }
    if (path === '/bookmarks/up') {
      await moveBookmarkUp(pool, { ...scope, who, href: String(form.get('href') ?? '') });
      return go('/bookmarks') ?? true;
    }
    if (path === '/navigation') {
      await savePins(pool, { ...scope, who, pins: form.getAll('pin') });
      return go('/navigation', 'ok', 'Pinned apps saved.') ?? true;
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return go(path === '/navigation' ? '/navigation' : '/bookmarks', 'error', error.message) ?? true;
  }
  throw new HttpError(405, 'Method not allowed');
}
