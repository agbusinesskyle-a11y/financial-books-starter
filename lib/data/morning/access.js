import { withSecurityWrite } from './locks.js';

const TRUSTED = new WeakSet();
export class MorningAccessError extends Error {
  constructor(reason) { super(reason === 'stale_session' || reason === 'foreign_org' ? 'Sign in again' : 'Morning View is limited to the owner and one named viewer.'); this.reason = reason; }
}
export const isTrustedActor = a => TRUSTED.has(a);
export const isTrustedOwner = (a, orgId) => TRUSTED.has(a) && a.owner && a.orgId === orgId;
export const viewerKeyOf = who => who.owner ? 'owner' : String(who.userId);
export function trustedActor(who, orgId, session) {
  if (!who || !session?.id || !Number.isSafeInteger(orgId) || orgId <= 0 || !Number.isSafeInteger(session.version)) throw new Error('trusted actor required');
  const owner = who.owner === true && session.userId == null;
  if (!owner && (!Number.isSafeInteger(who.userId) || who.userId !== session.userId)) throw new Error('trusted actor required');
  if (!owner && who.orgId !== orgId) throw new MorningAccessError('foreign_org');
  const actor = Object.freeze({ orgId, owner, userId: owner ? null : who.userId, viewerKey: owner ? 'owner' : String(who.userId), sessionId: session.id, sessionVersion: session.version });
  TRUSTED.add(actor);
  return actor;
}
export async function appOrg(db, orgSlug) {
  if (typeof orgSlug !== 'string' || !orgSlug) return null;
  const { rows: [r] } = await db.query('SELECT org_id FROM org WHERE slug=$1', [orgSlug]);
  return r ? { orgId: r.org_id } : null;
}
export async function ensureOwnerViewer(pool, orgId) {
  return withSecurityWrite(pool, { orgId }, async tx => {
    await tx.query("INSERT INTO morning_viewer (org_id,viewer_key,enrollment_state) VALUES ($1,'owner','ready') ON CONFLICT DO NOTHING", [orgId]);
    await tx.query("INSERT INTO morning_preference (org_id,viewer_key,membership_epoch) SELECT org_id,viewer_key,membership_epoch FROM morning_viewer WHERE org_id=$1 AND viewer_key='owner' ON CONFLICT DO NOTHING", [orgId]);
  });
}
// This check deliberately retains the authenticated request's original generation.
export async function validateActorIn(tx, identity) {
  if (!isTrustedActor(identity)) throw new Error('trusted actor required');
  if (identity.owner) return null;
  const { rows: [u] } = await tx.query('SELECT * FROM app_user WHERE user_id=$1', [identity.userId]);
  if (u && u.org_id !== identity.orgId) throw new MorningAccessError('foreign_org');
  if (!u || !u.active || !u.password_hash || !u.totp_enc || u.signin_version !== identity.sessionVersion) throw new MorningAccessError('stale_session');
  return u;
}
export async function validateMorningIdentityIn(tx, { identity, ownerOnly = false }) {
  await validateActorIn(tx, identity);
  if (ownerOnly && !identity.owner) throw new MorningAccessError('not_viewer');
  const { rows: [v] } = await tx.query(`SELECT v.enrollment_state,v.membership_epoch,p.membership_epoch AS preference_epoch
    FROM morning_viewer v LEFT JOIN morning_preference p USING (org_id,viewer_key) WHERE v.org_id=$1 AND v.viewer_key=$2`, [identity.orgId, identity.viewerKey]);
  if (v?.enrollment_state === 'pending_enrollment') throw new MorningAccessError('pending');
  if (!v || v.enrollment_state !== 'ready' || v.preference_epoch !== v.membership_epoch) throw new MorningAccessError('not_viewer');
  return { viewerKey: identity.viewerKey, epoch: v.membership_epoch, isOwner: identity.owner };
}
export const currentViewer = (db, args) => validateMorningIdentityIn(db, args);
