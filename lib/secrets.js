import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// AES-256-GCM for settings secrets (SMTP passwords). SETTINGS_KEY is 32 bytes, base64 or hex.
// Stored form: "v1:<iv b64>:<tag b64>:<ciphertext b64>".

export function settingsKey(env = process.env) {
  const text = env.SETTINGS_KEY;
  if (!text) return null;
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  if (key.length !== 32) throw new Error('SETTINGS_KEY must be 32 bytes (64 hex characters or base64).');
  return key;
}

export function encryptSecret(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(key, stored) {
  const [version, iv, tag, body] = String(stored).split(':');
  if (version !== 'v1' || !body) throw new Error('Unreadable stored secret.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
