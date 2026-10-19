export const MORNING_PREFIX = /^\/(morning|settings\/morning)(\/|$)/;
const ROUTES = new Map([
  ['/morning', ['GET', 'page']], ['/morning/entries', ['GET', 'entries']], ['/morning/attention', ['GET', 'attention']],
  ['/morning/dismissed', ['GET', 'dismissed']], ['/morning/dismiss', ['POST', 'dismiss']], ['/morning/undismiss', ['POST', 'undismiss']],
  ['/settings/morning', ['GET', 'settings']], ['/settings/morning/preferences', ['POST', 'preferences']], ['/settings/morning/floors', ['POST', 'floors']],
  ['/settings/morning/viewer', ['POST', 'viewer', true]], ['/settings/morning/company-threshold', ['POST', 'company-threshold', true]],
  ['/settings/morning/delivery', ['POST', 'delivery', true]], ['/settings/morning/transport-approve', ['POST', 'transport-approve', true]],
]);
export function matchMorningRoute(method, path) {
  if (!MORNING_PREFIX.test(path)) {
    // Encoded separators can never create an additional spelling of the boundary.
    try { if (MORNING_PREFIX.test(decodeURIComponent(path))) return { error: 404 }; } catch { /* ordinary routing rejects malformed paths */ }
    return null;
  }
  const account = /^\/morning\/accounts\/([1-9][0-9]{0,15})$/.exec(path);
  if (account) {
    const accountId = Number(account[1]);
    if (!Number.isSafeInteger(accountId)) return { error: 404 };
    return method === 'GET' ? { route: 'account', ownerOnly: false, accountId } : { error: 405 };
  }
  const pair = ROUTES.get(path);
  if (!pair) return { error: 404 };
  return method === pair[0] ? { route: pair[1], ownerOnly: pair[2] === true } : { error: 405 };
}
