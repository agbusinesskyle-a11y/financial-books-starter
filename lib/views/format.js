// Display helpers shared by views.

export function formatDateTime(value, timeZone) {
  return new Date(value).toLocaleString('en-US', {
    timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function initials(name) {
  const words = String(name).replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?';
}

export function formatAddress(a) {
  if (!a) return '';
  const cityLine = [a.city, [a.state, a.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine].filter(Boolean).join(', ');
}

// Phone text -> digits safe for tel:/sms: links.
export const phoneHref = phone => String(phone ?? '').replace(/[^\d+]/g, '');
