import { test, before, after } from 'node:test';
import { itemForm, listFields, picks } from './bank-forms.js';

import assert from 'node:assert/strict';
import { startApp } from './app-harness.js';
import { freshDb } from './harness.js';
import { tieout } from './tieout.js';
import { buildSampleFeed, writeLedgerlineSample } from '../lib/bankfeed/sample.js';
import { pullCompany } from '../lib/bankfeed/pull.js';
import { linkCompany, saveMappings } from '../lib/data/bankfeeds.js';
import { getBankItem } from '../lib/data/banking.js';
import { listRules, learnedHistory, suggestFor, acceptSuggestions } from '../lib/bankfeed/rules.js';
import { aiClient, saveAiSettings, getAiSettings } from '../lib/ai/provider.js';
import { checkProposal } from '../lib/ai/vendor-research.js';
import { settingsKey } from '../lib/secrets.js';
import { canAccess } from '../lib/domain/roles.js';

// Stage B5: the AI provider layer (Claude or OpenRouter) and vendor research — with a stand-in provider, so nothing leaves
// the machine. Checks the requests each provider gets, how answers are read, that proposals only point at the company's
// own vendors and categories, that keys stay encrypted, and that nothing posts until a person accepts.
const KEY = 'sk-ant-test-0000000000000000000000000000';
const calls = [];
let reply = null; // what the stand-in provider answers next
const fakeFetch = async (url, init) => {
  calls.push({ url, init, body: JSON.parse(init.body) });
  const r = typeof reply === 'function' ? reply(url, init) : reply;
  return { ok: r.status === 200, status: r.status, json: async () => r.json };
};
const claudeAnswer = (obj, { pause = false } = {}) => ({ status: 200, json: {
  content: [{ type: 'text', text: 'Looking it up.' }, { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'tractor supply 1234 lubbock' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://www.tractorsupply.com/', title: 'Tractor Supply Co.', encrypted_content: 'x' },
      { type: 'web_search_result', url: 'javascript:alert(1)', title: 'bad' }] },
    { type: 'text', text: JSON.stringify(obj), citations: [{ type: 'web_search_result_location', url: 'https://www.tractorsupply.com/store/1234', title: 'Store 1234', cited_text: '…' }] }],
  usage: { input_tokens: 900, output_tokens: 120, server_tool_use: { web_search_requests: 1 } }, stop_reason: pause ? 'pause_turn' : 'end_turn' } });

let app, llDb, ll, feed, S, A, t;
const actor = 'tester';
const llId = name => feed.accounts.find(a => a.name === name).id;
const pool = () => app.db.pool;
before(async () => {
  llDb = await freshDb({ migrate: false });
  ll = llDb.pool;
  app = await startApp({ ledgerline: ll, aiFetch: fakeFetch, env: { SETTINGS_KEY: 'ab'.repeat(32) } });
  S = { orgId: app.ids.orgId, entityId: app.ids.entityId };
  A = app.ids.accounts;
  feed = await buildSampleFeed(pool(), { ...S, asOf: '2026-10-12' });
  feed.items.push({ id: '00000000-0000-5000-a000-00000000aa01', account: llId('Business Card'), revision: 1, pending: false, status: 'active', posted_date: '2026-10-11',
    amount: '-12.50', description: 'TRACTOR SUPPLY #1234 LUBBOCK TX', merchant: 'Tractor Supply', channel: 'in store' });
  await writeLedgerlineSample(ll, feed);
  await pool().query('UPDATE org SET ledgerline_org_id = $1 WHERE org_id = $2', [feed.org, S.orgId]);
  await linkCompany(pool(), ll, { ...S, llEntityId: feed.entities[0].id, actor });
  await pullCompany(pool(), ll, S);
  await saveMappings(pool(), { ...S, actor, choices: [{ id: llId('Business Card'), choice: String(A.card) }, { id: llId('Operating Checking'), choice: 'skip' },
    { id: llId('Business Savings'), choice: 'skip' }, { id: llId('Equipment Loan'), choice: 'skip' }] });
  await pullCompany(pool(), ll, S);
  t = tieout(app);
});
after(async () => { await app.close(); await llDb.drop(); });

const tractor = async () => (await pool().query(`SELECT item_id FROM bank_feed_item WHERE description = 'TRACTOR SUPPLY #1234 LUBBOCK TX' ORDER BY posted_date, item_id`)).rows.map(r => Number(r.item_id));

test('Claude: the request, web search, pause and continue, sources', async () => {
  calls.length = 0;
  let n = 0;
  reply = () => (n++ === 0 ? claudeAnswer({ a: 1 }, { pause: true }) : claudeAnswer({ business_name: 'X' }));
  const r = await aiClient({ provider: 'anthropic', apiKey: KEY, fetchImpl: fakeFetch }).ask({ model: 'claude-sonnet-5-5', system: 'sys', prompt: 'p', webSearch: true });
  assert.equal(calls.length, 2, 'a paused turn is sent back to continue');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.headers['x-api-key'], KEY);
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(calls[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }]);
  assert.equal(calls[0].body.model, 'claude-sonnet-5-5');
  assert.equal(calls[1].body.messages.at(-1).role, 'assistant');
  assert.match(r.text, /business_name/);
  assert.deepEqual(r.sources.map(s => s.url).sort(), ['https://www.tractorsupply.com/', 'https://www.tractorsupply.com/store/1234'], 'javascript: links dropped');
  assert.deepEqual(r.usage, { input: 1800, output: 240, searches: 2 });
  const noSearch = await aiClient({ provider: 'anthropic', apiKey: KEY, fetchImpl: fakeFetch }).ask({ model: 'm', system: 's', prompt: 'p' });
  assert.ok(noSearch && !('tools' in calls.at(-1).body));
});

test('OpenRouter: the request, web plugin, citations; errors say what happened', async () => {
  calls.length = 0;
  reply = { status: 200, json: { choices: [{ message: { content: '{"business_name":"Y"}', annotations: [{ type: 'url_citation', url_citation: { url: 'https://y.example', title: 'Y' } }] } }],
    usage: { prompt_tokens: 50, completion_tokens: 9 } } };
  const r = await aiClient({ provider: 'openrouter', apiKey: KEY, fetchImpl: fakeFetch }).ask({ model: 'anthropic/claude-sonnet-5.5', system: 'sys', prompt: 'p', webSearch: true });
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body.plugins, [{ id: 'web', max_results: 5 }]);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.deepEqual([r.text, r.sources[0].url, r.usage.input], ['{"business_name":"Y"}', 'https://y.example', 50]);
  reply = { status: 401, json: { error: { message: 'bad key' } } };
  await assert.rejects(aiClient({ provider: 'openrouter', apiKey: KEY, fetchImpl: fakeFetch }).ask({ model: 'm', system: 's', prompt: 'p' }), /refused the API key/);
  reply = { status: 529, json: { error: { message: 'Overloaded' } } };
  await assert.rejects(aiClient({ provider: 'anthropic', apiKey: KEY, fetchImpl: fakeFetch }).ask({ model: 'm', system: 's', prompt: 'p' }), /said: Overloaded/);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(aiClient({ provider: 'anthropic', apiKey: KEY, fetchImpl: down }).ask({ model: 'm', system: 's', prompt: 'p' }), /Couldn’t reach/);
});

test('a proposal only points at the company’s own vendors and categories', () => {
  const vendors = [{ vendor_id: 7, display_name: 'Tractor Supply' }], categories = [{ account_id: 30, name: 'Repairs' }];
  const p = checkProposal('Sure! {"business_name":"Tractor Supply Co.","vendor_id":7,"category_account_id":30,"confidence":"high","reasons":"Store 1234 is in Lubbock."} done',
    { vendors, categories });
  assert.deepEqual([p.vendor_id, p.new_vendor, p.category_account_id, p.confidence], [7, null, 30, 'high']);
  const q = checkProposal('{"business_name":"Shell","vendor_id":999,"category_account_id":12345,"confidence":"certain","new_vendor":{"display_name":"Shell Oil","website":"javascript:x","city":"Plainview"}}',
    { vendors, categories });
  assert.deepEqual([q.vendor_id, q.category_account_id, q.confidence, q.new_vendor.display_name, q.new_vendor.website, q.new_vendor.city], [null, null, 'low', 'Shell Oil', null, 'Plainview']);
  assert.throws(() => checkProposal('I could not find it.', { vendors, categories }), /no result/);
  assert.throws(() => checkProposal('{"nothing": true}', { vendors, categories }), /didn’t name a business/);
});

test('Settings → AI: key stays encrypted, kept when left empty, never shown or audited', async () => {
  let page = await (await app.get('/settings/ai')).text();
  assert.match(page, /Provider/);
  let res = await app.post('/settings/ai', { provider: 'anthropic', apiKey: '', model_vendor_research: '', webSearch: '1' });
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Enter the Claude \(Anthropic\) API key/);
  res = await app.post('/settings/ai', { provider: 'anthropic', apiKey: KEY, model_vendor_research: '', webSearch: '1' });
  assert.equal(res.status, 303);
  const { rows: [row] } = await pool().query('SELECT api_key_enc FROM ai_settings WHERE org_id = $1', [S.orgId]);
  assert.ok(row.api_key_enc.startsWith('v1:') && !row.api_key_enc.includes(KEY));
  page = await (await app.get('/settings/ai')).text();
  assert.ok(!page.includes(KEY) && /Saved — leave empty to keep it/.test(page));
  res = await app.post('/settings/ai', { provider: 'anthropic', apiKey: '', model_vendor_research: 'claude-opus-5-5', webSearch: '1' });
  assert.equal(res.status, 303, 'blank keeps the key');
  assert.equal((await getAiSettings(pool(), S)).models.vendor_research, 'claude-opus-5-5');
  await assert.rejects(saveAiSettings(pool(), { ...S, provider: 'openrouter', apiKey: '', key: settingsKey({ SETTINGS_KEY: 'ab'.repeat(32) }), actor }), /OpenRouter \(any model\) API key/);
  await assert.rejects(saveAiSettings(pool(), { ...S, provider: 'anthropic', apiKey: 'short', key: settingsKey({ SETTINGS_KEY: 'ab'.repeat(32) }), actor }), /doesn’t look like an API key/);
  const audit = await pool().query(`SELECT coalesce(before::text, '') || coalesce(after::text, '') AS j FROM audit_log WHERE table_name = 'ai_settings'`);
  assert.ok(audit.rows.length && audit.rows.every(r => !r.j.includes('api_key_enc') && !r.j.includes(KEY)));
  assert.equal(canAccess('standard', 'GET', '/settings/ai'), false);
});

test('research → accept (new vendor) → Add: nothing posts until a person adds it', async () => {
  const [id, other] = await tractor();
  calls.length = 0;
  reply = claudeAnswer({ business_name: 'Tractor Supply Co.', what_they_do: 'Farm and ranch supply store', vendor_id: null,
    new_vendor: { display_name: 'Tractor Supply Co.', website: 'tractorsupply.com', city: 'Lubbock', state: 'TX' }, category_account_id: A.repairs, confidence: 'high',
    reasons: 'Store #1234 is the Lubbock, TX location.' });
  const a = await t.snapshot();
  let res = await app.post(`/banking/item/${id}/research`, {});
  assert.equal(res.status, 303);
  // What went to the provider: the bank line, vendor names and categories — and the model chosen for the job.
  const sent = calls[0].body;
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.match(sent.messages[0].content, /TRACTOR SUPPLY #1234 LUBBOCK TX/);
  assert.match(sent.messages[0].content, new RegExp(`${A.repairs}: Repairs & Maintenance`));
  assert.ok(!JSON.stringify(sent).includes(KEY));
  let page = await (await app.get(`/banking/item/${id}`)).text();
  assert.match(page, /Who is this\?/);
  assert.match(page, /<strong>Tractor Supply Co\.<\/strong> — Farm and ranch supply store/);
  assert.match(page, /href="https:\/\/www\.tractorsupply\.com\/store\/1234" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.match(page, /New vendor: Tractor Supply Co\. · Lubbock, TX · tractorsupply\.com/);
  // The other item with the same payee gets it as a suggestion — never accepted in bulk. It is $84.17 against the researched
  // $12.50 (more than twice): the vendor carries over, the category doesn't (stage S5).
  const item2 = await getBankItem(pool(), { ...S, itemId: other });
  const s = await suggestFor(pool(), { ...S, item: item2, rules: await listRules(pool(), S), history: await learnedHistory(pool(), S) });
  assert.deepEqual([s.source, s.accountId, s.confidence], ['ai', null, 'low']);
  assert.equal((await acceptSuggestions(pool(), { ...S, llAccountId: llId('Business Card'), itemIds: [other], actor })).accepted, 0);
  const { rows: [r] } = await pool().query('SELECT research_id FROM vendor_research WHERE item_id = $1', [id]);
  res = await app.post(`/banking/research/${r.research_id}/accept`, {});
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  const { rows: [v] } = await pool().query(`SELECT vendor_id, website FROM vendor WHERE entity_id = $1 AND display_name = 'Tractor Supply Co.'`, [S.entityId]);
  assert.ok(v, 'vendor created');
  assert.equal(loc, `/banking/item/${id}?research=${r.research_id}`, 'the form is filled from the research, checked again for the line as it is');
  const b = await t.snapshot();
  t.checkTied(b, 'after accept');
  t.expectChange(a, b, { label: 'accepting posts nothing' });
  page = await (await app.get(loc)).text();
  assert.match(page, /<input name="payee" list="item-payees" autocomplete="off" value="Tractor Supply Co\."/);
  assert.match(page, /<input name="line_account" list="item-cats" autocomplete="off" value="Repairs &amp; Maintenance"/);
  res = await app.post(`/banking/item/${id}/add`, new URLSearchParams([...await picks(app, id), ['rev', (await itemForm(app, id)).rev], ['payee', 'Tractor Supply Co.'], ['line_account', 'Repairs & Maintenance'], ['line_amount', ''], ['line_description', ''], ['memo', '']]));
  assert.equal(res.status, 303);
  const c = await t.snapshot();
  t.checkTied(c, 'after add');
  t.expectChange(b, c, { accounts: { [A.card]: -8417, [A.repairs]: 8417 }, net: -8417, label: 'add' });
  const { rows: [call] } = await pool().query(`SELECT job, model, input_tokens, searches, ok FROM ai_call ORDER BY call_id DESC LIMIT 1`);
  assert.deepEqual(call, { job: 'vendor_research', model: 'claude-opus-5-5', input_tokens: 900, searches: 1, ok: true });
});

test('a failed call is recorded and said plainly; reject; off means nothing is sent', async () => {
  const [, other] = await tractor();
  reply = { status: 529, json: { error: { message: 'Overloaded' } } };
  let res = await app.post(`/banking/item/${other}/research`, {});
  assert.equal(res.status, 422);
  assert.match(await res.text(), /Research didn’t work: The AI provider said: Overloaded/);
  assert.equal((await pool().query('SELECT ok FROM ai_call ORDER BY call_id DESC LIMIT 1')).rows[0].ok, false);
  reply = claudeAnswer({ business_name: 'Somebody Else', vendor_id: null, new_vendor: { display_name: 'Somebody Else' }, category_account_id: null, confidence: 'low', reasons: 'Guess.' });
  res = await app.post(`/banking/item/${other}/research`, {});
  assert.equal(res.status, 303);
  const { rows: [r] } = await pool().query(`SELECT research_id FROM vendor_research WHERE item_id = $1 AND status = 'done' ORDER BY research_id DESC LIMIT 1`, [other]);
  res = await app.post(`/banking/research/${r.research_id}/reject`, {});
  assert.equal(res.status, 303);
  assert.equal((await pool().query(`SELECT count(*)::int AS n FROM vendor WHERE display_name = 'Somebody Else'`)).rows[0].n, 0);
  await app.post('/settings/ai', { provider: 'off', apiKey: '', model_vendor_research: '', webSearch: '1' });
  calls.length = 0;
  res = await app.post(`/banking/item/${other}/research`, {});
  assert.equal(res.status, 422);
  assert.match(await res.text(), /AI is off/);
  assert.equal(calls.length, 0, 'nothing sent');
  const page = await (await app.get(`/banking/item/${other}`)).text();
  assert.match(page, /Rejected by/);
  assert.doesNotMatch(page, /Research (this payee|again)/, 'no way to send anything while AI is off');
  assert.equal(canAccess('reports', 'POST', `/banking/item/${other}/research`), false);
});

test('citation markers are taken out of the words, and sources the model lists are kept (links only)', () => {
  const p = checkProposal(JSON.stringify({ business_name: 'Example Horse Supply', vendor_id: null, new_vendor: { display_name: 'Example Horse Supply' }, confidence: 'medium',
    reasons: 'HoofCare is sold by Example Horse Supply. (cite index="7-3">Sale price $69.00</cite> is one example.',
    sources: ['https://horsesupply.example/products/hoof-care', 'javascript:alert(1)', 'not a url'] }), { vendors: [], categories: [] });
  assert.equal(p.reasons, 'HoofCare is sold by Example Horse Supply. Sale price $69.00 is one example.');
  assert.deepEqual(p.sources, ['https://horsesupply.example/products/hoof-care']);
});
