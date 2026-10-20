// Hosting configuration only. Never take this designation from a form or session.
export function ownerUserIdFromEnv(env) {
  const value = env.APP_OWNER_USER_ID;
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('APP_OWNER_USER_ID must be a positive safe integer identifying a Settings > Users account.');
  }
  return Number(value);
}

export async function validateOwnerAccount(db, { ownerUserId, orgId }) {
  if (ownerUserId === null) return;
  const { rows: [user] } = await db.query('SELECT org_id FROM app_user WHERE user_id=$1', [ownerUserId]);
  if (!user || user.org_id !== orgId) {
    throw new Error('APP_OWNER_USER_ID must identify an existing Settings > Users account in APP_ORG.');
  }
}
