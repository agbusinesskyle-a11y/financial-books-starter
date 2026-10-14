import { withTransaction } from '../db.js';
import { ValidationError } from './writes.js';
import { GROUPS, DEFAULT_PINS } from '../views/nav.js';

// Each person's bookmarks and pinned apps (stage N1). user_key = user id, or 'owner' for the environment login.
export const navUserKey = who => String(who.userId ?? 'owner');
const MAX_BOOKMARKS = 50;
const MAX_PINS = 6;

// Only paths on this site: "/x…", never "//host" or a backslash trick; no control characters.
export function cleanHref(value) {
  const href = String(value ?? '').trim();
  if (!/^\/(?![/\\])[^\s\\]*$/.test(href) || href.length > 500 || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^\/(logout|login)(\/|\?|$)/.test(href)) return null;
  return href;
}

export async function getNav(db, { orgId, entityId, who }) {
  const key = navUserKey(who);
  const [b, p] = await Promise.all([
    db.query('SELECT href, label FROM nav_bookmark WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 ORDER BY position, created_at', [orgId, entityId, key]),
    db.query('SELECT pinned FROM nav_pref WHERE org_id = $1 AND entity_id = $2 AND user_key = $3', [orgId, entityId, key]),
  ]);
  const known = new Set(GROUPS.map(g => g.key));
  return { bookmarks: b.rows, pins: p.rows[0] ? p.rows[0].pinned.filter(k => known.has(k)) : DEFAULT_PINS };
}

export async function addBookmark(db, { orgId, entityId, who, href, label }) {
  const h = cleanHref(href);
  if (!h) throw new ValidationError('That page can’t be bookmarked.');
  const l = String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || h;
  const key = navUserKey(who);
  const { rows: [{ n, pos }] } = await db.query(
    'SELECT count(*)::int AS n, coalesce(max(position), 0)::int AS pos FROM nav_bookmark WHERE org_id = $1 AND entity_id = $2 AND user_key = $3', [orgId, entityId, key]);
  if (n >= MAX_BOOKMARKS) throw new ValidationError(`You can keep up to ${MAX_BOOKMARKS} bookmarks. Remove one first.`);
  await db.query(`INSERT INTO nav_bookmark (org_id, entity_id, user_key, href, label, position) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (org_id, entity_id, user_key, href) DO UPDATE SET label = EXCLUDED.label`, [orgId, entityId, key, h, l, pos + 1]);
  return h;
}

export async function removeBookmark(db, { orgId, entityId, who, href }) {
  await db.query('DELETE FROM nav_bookmark WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 AND href = $4', [orgId, entityId, navUserKey(who), String(href ?? '')]);
}

// Swap a bookmark with the one above it.
export async function moveBookmarkUp(pool, { orgId, entityId, who, href }) {
  const key = navUserKey(who);
  // One transaction, the person's rows locked, so quick repeated clicks can't leave two bookmarks in the same place.
  await withTransaction(pool, async tx => {
    const { rows } = await tx.query('SELECT href FROM nav_bookmark WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 ORDER BY position, created_at FOR UPDATE',
      [orgId, entityId, key]);
    const list = rows.map(r => r.href);
    const i = list.indexOf(href);
    if (i <= 0) return;
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    for (const [pos, h] of list.entries()) {
      await tx.query('UPDATE nav_bookmark SET position = $5 WHERE org_id = $1 AND entity_id = $2 AND user_key = $3 AND href = $4', [orgId, entityId, key, h, pos + 1]);
    }
  });
}

export async function savePins(db, { orgId, entityId, who, pins }) {
  const known = new Set(GROUPS.map(g => g.key));
  const list = [...new Set((pins ?? []).map(String))].filter(k => known.has(k));
  if (list.length > MAX_PINS) throw new ValidationError(`Pin up to ${MAX_PINS} apps.`);
  await db.query(`INSERT INTO nav_pref (org_id, entity_id, user_key, pinned) VALUES ($1, $2, $3, $4)
    ON CONFLICT (org_id, entity_id, user_key) DO UPDATE SET pinned = EXCLUDED.pinned`, [orgId, entityId, navUserKey(who), list]);
}
