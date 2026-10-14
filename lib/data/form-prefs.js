import { FORM_SAVE } from '../domain/save-choices.js';

// Each person's last save choice per form (stage F1). user: the signed-in person's id, or null for the owner login.
const keyOf = userId => (userId ? `u:${userId}` : 'owner');

export async function preferredChoice(db, { orgId, userId, type }) {
  const { rows: [r] } = await db.query('SELECT choice FROM form_save_pref WHERE org_id = $1 AND user_key = $2 AND form_type = $3', [orgId, keyOf(userId), type]);
  return r && FORM_SAVE[type]?.choices.includes(r.choice) ? r.choice : null;
}

export async function rememberChoice(db, { orgId, userId, type, choice }) {
  if (!FORM_SAVE[type]?.choices.includes(choice)) return;
  await db.query(`INSERT INTO form_save_pref (org_id, user_key, form_type, choice) VALUES ($1, $2, $3, $4)
    ON CONFLICT (org_id, user_key, form_type) DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`, [orgId, keyOf(userId), type, choice]);
}
