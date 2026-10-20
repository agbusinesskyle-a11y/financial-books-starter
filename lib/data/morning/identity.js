import { randomBytes, createHash } from 'node:crypto';
import { ValidationError } from '../writes.js';
import { withSecurityWrite } from './locks.js';
import { isTrustedActor, isTrustedOwner, validateActorIn, validateMorningIdentityIn, MorningAccessError } from './access.js';

export class ProtectedIdentityError extends Error {
  constructor(message = 'Only the owner can change this person’s sign-in or access: they are a Morning View viewer.') { super(message); }
}
const fail = message => { throw new ValidationError(message); };
export const requireSettingsKey = key => { if (!key) fail('The server has no SETTINGS_KEY, so authenticators can’t be stored safely. Add SETTINGS_KEY first.'); };
export async function protectedState(db, { orgId, userId }) {
  const { rows: [v] } = await db.query("SELECT enrollment_state FROM morning_viewer WHERE org_id=$1 AND user_id=$2 AND enrollment_state IN ('pending_enrollment','ready')", [orgId, userId]);
  return v?.enrollment_state ?? null;
}
export async function assertMayAdminister(tx, { actorCtx, orgId, userId }) {
  if (!isTrustedActor(actorCtx) || actorCtx.orgId !== orgId) throw new Error('trusted actor required');
  const actor = await validateActorIn(tx, actorCtx);
  if (actorCtx.ownerUserId === userId || await protectedState(tx, { orgId, userId })) {
    if (!isTrustedOwner(actorCtx, orgId)) throw new ProtectedIdentityError();
  } else if (!actorCtx.owner && (actor.role !== 'admin' || !actor.all_companies)) throw new MorningAccessError('not_viewer');
}
export async function secondViewer(db, { orgId }) {
  const { rows: [v] } = await db.query(`SELECT u.user_id,u.name,u.email,v.enrollment_state,v.membership_epoch FROM morning_viewer v
    JOIN app_user u ON u.org_id=v.org_id AND u.user_id=v.user_id WHERE v.org_id=$1 AND v.enrollment_state IN ('pending_enrollment','ready')`, [orgId]);
  return v ? { userId: v.user_id, name: v.name, email: v.email, state: v.enrollment_state, epoch: v.membership_epoch } : null;
}
async function clearViewerIn(tx, orgId, viewerKey) {
  for (const table of ['visit', 'snapshot_generation', 'preference', 'floor', 'dismissal']) await tx.query(`DELETE FROM morning_${table} WHERE org_id=$1 AND viewer_key=$2`, [orgId, viewerKey]);
}
export async function revokeMembershipIn(tx, { orgId, viewerKey }) {
  if (viewerKey === 'owner') throw new ProtectedIdentityError('The owner remains a viewer.');
  await clearViewerIn(tx, orgId, viewerKey);
  const { rows: [v] } = await tx.query("UPDATE morning_viewer SET enrollment_state='disabled',membership_epoch=membership_epoch+1 WHERE org_id=$1 AND viewer_key=$2 RETURNING user_id", [orgId, viewerKey]);
  if (v) {
    await tx.query('UPDATE app_user SET signin_version=signin_version+1 WHERE org_id=$1 AND user_id=$2', [orgId, v.user_id]);
    await tx.query('DELETE FROM user_invite WHERE org_id=$1 AND user_id=$2 AND used_at IS NULL', [orgId, v.user_id]);
  }
}
async function requireOwner(tx, { actorCtx, orgId }) {
  if (!isTrustedOwner(actorCtx, orgId)) throw new ProtectedIdentityError('Only the owner can choose the second viewer.');
  await validateMorningIdentityIn(tx, {identity:actorCtx,ownerOnly:true});
}
export async function ownerResetViewerIn(tx, { actorCtx, orgId, userId, key, now = new Date() }) {
  await requireOwner(tx, { actorCtx, orgId }); requireSettingsKey(key);
  if (userId === actorCtx.ownerUserId) fail('The owner account is already the owner and cannot be the second viewer.');
  const { rows: [u] } = await tx.query('SELECT active FROM app_user WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  if (!u?.active) fail('Choose an active person in these books.');
  await tx.query('UPDATE app_user SET password_hash=NULL,totp_enc=NULL,last_totp_counter=-1,signin_version=signin_version+1 WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  await tx.query('DELETE FROM user_invite WHERE org_id=$1 AND user_id=$2 AND used_at IS NULL', [orgId, userId]);
  const viewerKey = String(userId);
  const { rows: [v] } = await tx.query(`INSERT INTO morning_viewer (org_id,viewer_key,user_id,enrollment_state,membership_epoch,granted_at)
    VALUES ($1,$2,$3,'pending_enrollment',1,$4) ON CONFLICT (org_id,viewer_key) DO UPDATE SET
    enrollment_state='pending_enrollment',membership_epoch=morning_viewer.membership_epoch+1,granted_at=$4 RETURNING membership_epoch`, [orgId, viewerKey, userId, now]);
  await clearViewerIn(tx, orgId, viewerKey);
  await tx.query('INSERT INTO morning_preference (org_id,viewer_key,membership_epoch) VALUES ($1,$2,$3)', [orgId, viewerKey, v.membership_epoch]);
  const token = randomBytes(32).toString('base64url');
  await tx.query(`INSERT INTO user_invite (org_id,user_id,token_hash,expires_at,created_by,owner_issued,morning_membership_epoch)
    VALUES ($1,$2,$3,$4,'owner',true,$5)`, [orgId, userId, createHash('sha256').update(token).digest('hex'), new Date(now.getTime() + 7 * 86400000), v.membership_epoch]);
  return { token, ownerCopyOnly: true, epoch: v.membership_epoch };
}
export async function grantSecondViewer(pool, args) {
  let previous;
  return withSecurityWrite(pool, { orgId: args.orgId, userIds: [args.userId], hooks: { discoverUserIds: async tx => {
    await requireOwner(tx, args); previous = await secondViewer(tx, args); return previous ? [previous.userId] : [];
  } } }, async tx => {
    // Check the target before revoking the old viewer; any refusal rolls back the entire replacement.
    if (args.userId === args.actorCtx.ownerUserId) fail('The owner account is already the owner and cannot be the second viewer.');
    const { rows: [u] } = await tx.query('SELECT active FROM app_user WHERE org_id=$1 AND user_id=$2', [args.orgId, args.userId]);
    if (!u?.active) fail('Choose an active person in these books.');
    if (previous && previous.userId !== args.userId) await revokeMembershipIn(tx, { orgId: args.orgId, viewerKey: String(previous.userId) });
    return { ...await ownerResetViewerIn(tx, args), replacedUserId: previous && previous.userId !== args.userId ? previous.userId : null };
  });
}
export async function removeSecondViewer(pool, args) {
  let previous;
  return withSecurityWrite(pool, { orgId: args.orgId, hooks: { discoverUserIds: async tx => {
    await requireOwner(tx, args); previous = await secondViewer(tx, args); return previous ? [previous.userId] : [];
  } } }, async tx => {
    if (previous) await revokeMembershipIn(tx, { orgId: args.orgId, viewerKey: String(previous.userId) });
    return { removedUserId: previous?.userId ?? null };
  });
}
export const ownerResetViewer = (pool, args) => withSecurityWrite(pool, { orgId: args.orgId, userIds: [args.userId] }, tx => ownerResetViewerIn(tx, args));

// Each dedicated transaction gets at most one epoch advance even for a combined route edit.
const advanced = new WeakMap();
export async function advanceIdentityEpochIn(tx, { orgId, userId, changes, now = new Date() }) {
  if (!await protectedState(tx, { orgId, userId })) return { epoch: null, changed: false };
  const { rows: [u] } = await tx.query('SELECT email,role,can_approve_bills,all_companies FROM app_user WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  let changed = Object.entries(changes).some(([k, v]) => k !== 'companyIds' && Object.hasOwn(u, k) && u[k] !== v);
  if (Object.hasOwn(changes, 'companyIds')) {
    const { rows } = await tx.query('SELECT entity_id FROM app_user_company WHERE org_id=$1 AND user_id=$2 ORDER BY entity_id', [orgId, userId]);
    changed ||= JSON.stringify(rows.map(r => r.entity_id)) !== JSON.stringify([...new Set(changes.companyIds)].sort((a,b) => a-b));
  }
  const key = `${orgId}:${userId}`, seen = advanced.get(tx) ?? new Map();
  if (changed && !seen.has(key)) {
    const { rows: [v] } = await tx.query('UPDATE morning_viewer SET membership_epoch=membership_epoch+1 WHERE org_id=$1 AND user_id=$2 RETURNING membership_epoch', [orgId, userId]);
    await tx.query('UPDATE app_user SET signin_version=signin_version+1 WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
    await tx.query('DELETE FROM user_invite WHERE org_id=$1 AND user_id=$2 AND used_at IS NULL', [orgId, userId]);
    await tx.query('UPDATE morning_preference SET membership_epoch=$3,settings_version=settings_version+1,updated_at=$4 WHERE org_id=$1 AND viewer_key=$2', [orgId, String(userId), v.membership_epoch, now]);
    seen.set(key, v.membership_epoch); advanced.set(tx, seen);
  }
  const { rows: [v] } = await tx.query('SELECT membership_epoch FROM morning_viewer WHERE org_id=$1 AND user_id=$2', [orgId, userId]);
  return { epoch: v.membership_epoch, changed };
}
