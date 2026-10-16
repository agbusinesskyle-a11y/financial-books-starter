import { test, before, after } from 'node:test';
import { itemForm, picks } from './bank-forms.js';
import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { generateSample } from '../lib/seed/generate.js';
import { writeSample } from '../lib/data/seed.js';
import { buildSampleFeed, writeLedgerlineSample } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { saveVendor } from '../lib/data/vendors.js';
import { saveAiSettings } from '../lib/ai/provider.js';
import { settingsKey } from '../lib/secrets.js';
import { twilioSignature, normalPhone, companyFromText } from '../lib/sms/twilio.js';
import { checkReading } from '../lib/sms/receipts.js';
import { canAccess } from '../lib/domain/roles.js';

// Stage B8: text-a-receipt, end to end with a stand-in Twilio and a stand-in AI (nothing leaves the machine): the
// signed webhook, approved senders, which company, reading, matching the bank charge, adding when sure, waiting for a
// charge that hasn't come in, asking "Which company?", and texting back.
const BASE = 'https://books.example';
const SID = `AC${'a1'.repeat(16)}`, TOKEN = 'b2'.repeat(16), NUMBER = '+12025550100', OWNER_PHONE = '+12025550109';
const ENV = { SETTINGS_KEY: 'ab'.repeat(32), APP_BASE_URL: BASE };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
let reading = null; // what the stand-in AI reads off the next receipt
const sent = [], aiCalls = [];
let mediaType = 'image/jpeg';
const aiFetch = async (url, init) => {
  aiCalls.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(reading) }], usage: { input_tokens: 1200, output_tokens: 80 }, stop_reason: 'end_turn' }) };
};
const smsFetch = async (url, init = {}) => {
  if (String(url).includes('/Messages.json')) { sent.push({ url, auth: init.headers.authorization, body: new URLSearchParams(init.body) }); return { ok: true, status: 201 }; }
  assert.equal(init.headers.authorization, `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`, 'media fetched with the account’s credentials');
  return { ok: true, status: 200, headers: new Map([['content-type', mediaType]]), arrayBuffer: async () => JPEG };
};

let app, llDb, ll, feed, S, B, A, t, msg = 0;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll, aiFetch, smsFetch, env: ENV });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card) }, { id: llId('Operating Checking'), choice: 'skip' },
    { id: llId('Business Savings'), choice: 'skip' }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
  const s = generateSample({ asOf: '2026-10-12', seed: 7 });
  s.entity = { ...s.entity, name: 'High Plains Hay' };
  B = { orgId: S.orgId, entityId: (await writeSample(pool(), s, { addCompany: true })).entityId };
  // Tractor Supply is a vendor whose purchases go to Repairs & Maintenance.
  await saveVendor(pool(), { ...S, actor, fields: { displayName: 'Tractor Supply', defaultExpenseAccountId: String(A.repairs) } });
  await saveAiSettings(pool(), { ...S, provider: 'anthropic', apiKey: 'sk-ant-test-0000000000000000000000000000', key: settingsKey(ENV), actor });
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

const text = async (fields, { sign = true, to = NUMBER } = {}) => {
  const params = new URLSearchParams({ AccountSid: SID, MessageSid: `MM${String(++msg).padStart(32, '0')}`, From: OWNER_PHONE, To: to, Body: '', NumMedia: '1',
    MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME${msg}`, MediaContentType0: 'image/jpeg', ...fields });
  const signature = sign ? twilioSignature(TOKEN, `${BASE}/twilio/sms`, params) : 'bad';
  const res = await fetch(`${app.base}/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature }, body: params.toString() });
  const body = await res.text();
  return { status: res.status, body, reply: /<Message>([\s\S]*)<\/Message>/.exec(body)?.[1]?.replace(/&amp;/g, '&') ?? '', sid: params.get('MessageSid') };
};
const receiptOf = async sid => (await pool().query('SELECT * FROM receipt WHERE message_sid = $1', [sid])).rows[0];

test('phone numbers, company names with a typo, and the reading are checked', () => {
  assert.equal(normalPhone('(202) 555-0109'), OWNER_PHONE);
  assert.equal(normalPhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalPhone('555-0109'), null);
  const cos = [{ entityId: 1, name: 'Sample Feed', nicknames: ['CF'] }, { entityId: 2, name: 'High Plains Hay', nicknames: ['HP'] }];
  assert.equal(companyFromText('cf', cos), 1);
  assert.equal(companyFromText('this is for Sample Fead thanks', cos), 1);
  assert.equal(companyFromText('hp', cos), 2);
  assert.equal(companyFromText('cf or hp?', cos), null, 'two named: ask');
  assert.equal(companyFromText('lunch', cos), null);
  assert.deepEqual(checkReading('{"vendor":"Shell","date":"2026-10-05","total":"61.02","tax":0.52,"card_last4":"1199","confidence":"high"}'),
    { vendor: 'Shell', date: '2026-10-05', total_cents: 6102, tax_cents: 52, payment_method: null, card_last4: '1199', summary: null, confidence: 'high' });
  assert.throws(() => checkReading('{"vendor":"x","total":-5}'), /no total/);
  assert.throws(() => checkReading('I can’t read this'), /nothing was read/);
});

test('Settings → Text receipts: Twilio account, senders and nicknames; the token stays secret', async () => {
  let res = await app.post('/settings/text-receipts', { section: 'twilio', accountSid: 'nope', authToken: '', phone: '', enabled: '1' });
  assert.equal(res.status, 422);
  res = await app.post('/settings/text-receipts', { section: 'twilio', accountSid: SID, authToken: TOKEN, phone: '(202) 555-0100', enabled: '1' });
  assert.equal(res.status, 303);
  const page = await (await app.get('/settings/text-receipts')).text();
  assert.ok(!page.includes(TOKEN));
  assert.match(page, /https:\/\/books\.example\/twilio\/sms/);
  assert.equal((await app.post('/settings/text-receipts', { section: 'nicknames', [`nick_${S.entityId}`]: 'CF, Sample Feed', [`nick_${B.entityId}`]: 'HP' })).status, 303);
  assert.equal((await app.post('/settings/text-receipts', { section: 'nicknames', [`nick_${S.entityId}`]: 'CF', [`nick_${B.entityId}`]: 'cf' })).status, 422, 'one nickname, one company');
  assert.equal((await app.post('/settings/text-receipts', { section: 'nicknames', [`nick_${S.entityId}`]: 'CF, Sample Feed', [`nick_${B.entityId}`]: 'HP' })).status, 303);
  assert.equal((await app.post('/settings/text-receipts/senders', { name: 'Pat', phone: '(202) 555-0109', allCompanies: '1' })).status, 303);
  const { rows: [s] } = await pool().query('SELECT auth_token_enc, phone FROM sms_settings WHERE org_id = $1', [S.orgId]);
  assert.ok(s.auth_token_enc.startsWith('v1:') && s.phone === NUMBER);
  const audit = await pool().query(`SELECT coalesce(before::text, '') || coalesce(after::text, '') AS j FROM audit_log WHERE table_name = 'sms_settings'`);
  assert.ok(audit.rows.length && audit.rows.every(r => !r.j.includes(TOKEN)));
  assert.equal(canAccess('standard', 'GET', '/settings/text-receipts'), false);
});

test('only signed texts from approved numbers are taken', async () => {
  assert.equal((await text({ Body: 'CF' }, { sign: false })).status, 403);
  assert.equal((await text({ Body: 'CF' }, { to: '+12025550199' })).status, 404);
  const stranger = await text({ From: '+12145550000', Body: 'CF' });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.reply, '', 'no answer to strangers');
  assert.equal(await receiptOf(stranger.sid), undefined);
});

test('a receipt for a charge already in from the bank, with a known vendor: added, photo attached, texted back', async () => {
  reading = { vendor: 'Tractor Supply Co #1234', date: '2026-10-02', total: 84.17, tax: 6.4, payment_method: 'Visa', card_last4: '1199', summary: 'fence staples', confidence: 'high' };
  const a = await t.snapshot();
  const r = await text({ Body: 'CF' });
  assert.equal(r.status, 200);
  assert.match(r.reply, /: Tractor Supply Co #1234 \$84\.17/);
  assert.match(r.reply, /→ Repairs & Maintenance, matched to Business Card ••1199\.$/);
  const rec = await receiptOf(r.sid);
  assert.equal(rec.status, 'added');
  const b = await t.snapshot();
  t.checkTied(b, 'texted receipt');
  t.expectChange(a, b, { accounts: { [A.card]: -8417, [A.repairs]: 8417 }, net: -8417, label: 'texted receipt' });
  const { rows: [doc] } = await pool().query('SELECT filename, note, vendor_id FROM document WHERE txn_id = $1', [rec.txn_id]);
  assert.equal(doc.note, 'Texted receipt');
  const ai = aiCalls.at(-1);
  assert.equal(ai.messages[0].content[0].type, 'image');
  assert.equal(ai.messages[0].content[0].source.media_type, 'image/jpeg');
  // Twilio retries the same message: same answer, nothing new.
  const params = new URLSearchParams({ AccountSid: SID, MessageSid: r.sid, From: OWNER_PHONE, To: NUMBER, Body: 'CF', NumMedia: '1',
    MediaUrl0: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages/MM1/Media/ME${msg}`, MediaContentType0: 'image/jpeg' });
  const again = await fetch(`${app.base}/twilio/sms`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    'x-twilio-signature': twilioSignature(TOKEN, `${BASE}/twilio/sms`, params) }, body: params.toString() });
  assert.match(await again.text(), /matched to Business Card/);
  assert.equal((await pool().query('SELECT count(*)::int AS n FROM receipt WHERE message_sid = $1', [r.sid])).rows[0].n, 1);
});

test('no company in the text: the card’s last 4 digits decide; an unknown vendor waits for a look', async () => {
  reading = { vendor: 'Shell', date: '2026-10-05', total: 61.02, card_last4: '1199', confidence: 'high' };
  const r = await text({ Body: '' });
  assert.match(r.reply, /matched to Business Card ••1199; it needs a look on the Receipts page/);
  const rec = await receiptOf(r.sid);
  assert.deepEqual([Number(rec.entity_id), rec.status], [S.entityId, 'review']);
  const page = await (await app.get('/receipts?tab=review')).text();
  assert.match(page, new RegExp(`href="/banking/item/${rec.item_id}"`));
  assert.match(page, /The vendor isn’t one of this company’s yet/);
  const img = await app.get(`/receipts/${rec.receipt_id}/image`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPEG));
  // After the charge is added from the bank item page, the receipt is settled and the photo attached.
  const vendorId = await saveVendor(pool(), { ...S, actor, fields: { displayName: 'Shell' } });
  const res = await app.post(`/banking/item/${rec.item_id}/add`, new URLSearchParams([...await picks(app, rec.item_id), ['rev', (await itemForm(app, rec.item_id)).rev], ['payee', 'Shell'], ['line_account', 'Fuel'], ['line_amount', ''],
    ['line_description', ''], ['memo', '']]));
  assert.equal(res.status, 303);
  await app.get('/receipts');
  assert.equal((await receiptOf(r.sid)).status, 'added');
});

test('a receipt before its charge: waits, then matches after a pull, with a text', async () => {
  reading = { vendor: 'Love’s', date: '2026-10-11', total: 42.5, card_last4: '1199', confidence: 'high' };
  const r = await text({ Body: 'CF' });
  assert.match(r.reply, /saved\. It will be matched when the charge comes in from the bank\.$/);
  assert.equal((await receiptOf(r.sid)).status, 'waiting');
  // The pending charge posts at the bank.
  await ll.query(`UPDATE core.transaction SET pending = false, revision = 2 WHERE description_raw LIKE 'LOVES TRAVEL STOP%'`);
  sent.length = 0;
  const pull = await pullCompany(pool(), ll, { ...S, key: settingsKey(ENV), smsFetch });
  assert.equal(pull.receipts, 1);
  assert.equal((await receiptOf(r.sid)).status, 'review');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.get('To'), OWNER_PHONE);
  assert.equal(sent[0].body.get('From'), NUMBER);
  assert.match(sent[0].body.get('Body'), /Love’s \$42\.50 .* matched to Business Card ••1199/);
});

test('“Which company?” — and the answer (with a typo) settles it', async () => {
  reading = { vendor: 'Feed Store', date: '2026-10-10', total: 12, card_last4: null, confidence: 'medium' };
  const r = await text({ Body: 'thanks' });
  assert.match(r.reply, /Which company is it for\? Reply with one of: (CF, HP|HP, CF)\./);
  assert.equal((await receiptOf(r.sid)).status, 'needs_company');
  const answer = await text({ Body: 'sample fead', NumMedia: '0', MediaUrl0: '' });
  assert.match(answer.reply, /\$12\.00/);
  const rec = await receiptOf(r.sid);
  assert.deepEqual([Number(rec.entity_id), rec.status], [S.entityId, 'waiting']);
  // Another company can't open this company's receipts.
  assert.equal((await app.post('/company/switch', { entity_id: String(B.entityId) })).status, 303);
  assert.equal((await app.get(`/receipts/${rec.receipt_id}/image`)).status, 404);
  assert.equal((await app.post('/company/switch', { entity_id: String(S.entityId) })).status, 303);
});

test('pictures that can’t be used, and AI off, are said plainly', async () => {
  mediaType = 'text/html';
  let r = await text({ Body: 'CF' });
  assert.equal(r.reply, 'Send a photo (JPEG or PNG) or a PDF of the receipt.');
  assert.equal((await receiptOf(r.sid)).status, 'failed');
  mediaType = 'image/jpeg';
  r = await text({ Body: 'CF', MediaUrl0: 'https://evil.example/x.jpg' });
  assert.equal(r.reply, 'The picture didn’t come from Twilio.');
  await saveAiSettings(pool(), { ...S, provider: 'off', key: settingsKey(ENV), actor });
  r = await text({ Body: 'CF' });
  assert.match(r.reply, /Got it, but it couldn’t be read \(AI is off/);
  assert.equal((await receiptOf(r.sid)).status, 'failed');
  const page = await (await app.get('/receipts?tab=review')).text();
  assert.match(page, /Couldn’t be read/);
});

test('practice copy: a receipt sure enough to add waits on the Receipts page instead', async () => {
  const { sampleUuid } = await import('../lib/bankfeed/sample.js');
  await ll.query(`INSERT INTO core.transaction (org_id, transaction_id, account_id, amount, currency, posted_date, pending, description_raw, status, revision)
    VALUES ($1, $2, $3, -61.25, 'USD', '2026-10-11', false, 'TRACTOR SUPPLY #1234 LUBBOCK TX', 'active', 1)`, [feed.org, sampleUuid('practice-receipt'), llId('Business Card')]);
  await pullCompany(pool(), ll, { ...S, env: {} });
  // (The test before turns AI off.)
  await saveAiSettings(pool(), { ...S, provider: 'anthropic', apiKey: 'sk-ant-test-0000000000000000000000000000', key: settingsKey(ENV), actor });
  app.env.BOOKS_MODE = 'practice';
  try {
    reading = { vendor: 'Tractor Supply Co #1234', date: '2026-10-11', total: 61.25, tax: 4.6, payment_method: 'Visa', card_last4: '1199', summary: 'gate hinges', confidence: 'high' };
    const a = await t.snapshot();
    const sentBefore = sent.length;
    const r = await text({ Body: 'CF' });
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /<Message>/, 'no text back to the sender');
    assert.equal(sent.length, sentBefore);
    const rec = await receiptOf(r.sid);
    assert.equal(rec.status, 'review');
    assert.equal(rec.note, 'Practice copy: add it by hand.');
    assert.ok(rec.reply, 'what would have been said is kept on the receipt');
    // A text with no picture would normally get "send a photo" back; in practice, nothing.
    assert.doesNotMatch((await text({ Body: 'hello', NumMedia: '0', MediaUrl0: '' })).body, /<Message>/);
    assert.equal(rec.txn_id, null);
    t.expectChange(a, await t.snapshot(), { accounts: {}, net: 0, label: 'practice receipt' });
  } finally { delete app.env.BOOKS_MODE; }
});
