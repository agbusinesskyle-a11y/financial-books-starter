import { withTransaction } from '../db.js';
import { ValidationError } from '../data/writes.js';
import { encryptSecret, decryptSecret } from '../secrets.js';

// The AI provider layer (stage B5): Claude directly, or OpenRouter to switch models per job. One call
// shape for both — ask({ model, system, prompt, webSearch }) → { text, sources, usage } — so the jobs (vendor research
// now; receipts, the Ask box later) don't care which one is behind it. Off until an admin connects a provider and key in
// Settings → AI. Whatever a job sends (bank descriptions, vendor names) goes to that provider: the accepted trade-off.

const fail = message => { throw new ValidationError(message); };
export const PROVIDERS = { off: 'Off', anthropic: 'Claude (Anthropic)', openrouter: 'OpenRouter (any model)' };
export const JOBS = {
  vendor_research: { label: 'Vendor research', about: 'Looks up bank payees the books don’t recognize',
    defaults: { anthropic: 'claude-sonnet-5-5', openrouter: 'anthropic/claude-sonnet-5.5' } },
  receipt_reading: { label: 'Receipt reading', about: 'Reads texted receipt photos: vendor, date, total, tax, card',
    defaults: { anthropic: 'claude-sonnet-5-5', openrouter: 'anthropic/claude-sonnet-5.5' } },
};
const TIMEOUT_MS = 90_000;

export async function getAiSettings(db, { orgId }) {
  const { rows: [s] } = await db.query('SELECT * FROM ai_settings WHERE org_id = $1', [orgId]);
  return { provider: s?.provider ?? 'off', hasKey: Boolean(s?.api_key_enc), models: s?.models ?? {}, webSearch: s?.web_search ?? true,
    updatedBy: s?.updated_by ?? null, updatedAt: s?.updated_at ?? null, apiKeyEnc: s?.api_key_enc ?? null };
}

export const modelFor = (settings, job) => String(settings.models?.[job] ?? '').trim() || JOBS[job]?.defaults?.[settings.provider] || null;

// apiKey: '' keeps the saved key; a new value replaces it. Switching provider needs a new key.
export async function saveAiSettings(pool, { orgId, provider, apiKey = '', models = {}, webSearch = true, key, actor }) {
  if (!PROVIDERS[provider]) fail('Choose a provider.');
  const typed = String(apiKey ?? '').trim();
  if (typed && !key) fail('Saving an API key needs SETTINGS_KEY set on the server.');
  if (typed && (typed.length < 20 || /\s/.test(typed))) fail('That doesn’t look like an API key.');
  const clean = {};
  for (const [job, m] of Object.entries(models)) {
    if (!JOBS[job]) continue;
    const v = String(m ?? '').trim();
    if (v && !/^[\w./:@-]{2,100}$/.test(v)) fail(`${JOBS[job].label}: enter a model name like ${JOBS[job].defaults.anthropic}.`);
    if (v) clean[job] = v;
  }
  return withTransaction(pool, async tx => {
    const current = await getAiSettings(tx, { orgId });
    // Turning AI off keeps the key for later; moving from one provider to the other needs that provider's key.
    const otherProvider = current.provider !== 'off' && provider !== 'off' && current.provider !== provider;
    const enc = typed ? encryptSecret(key, typed) : (otherProvider ? null : current.apiKeyEnc);
    if (provider !== 'off' && !enc) fail(`Enter the ${PROVIDERS[provider]} API key.`);
    await tx.query(`INSERT INTO ai_settings (org_id, provider, api_key_enc, models, web_search, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, now())
      ON CONFLICT (org_id) DO UPDATE SET provider = EXCLUDED.provider, api_key_enc = EXCLUDED.api_key_enc, models = EXCLUDED.models,
        web_search = EXCLUDED.web_search, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, provider, enc, JSON.stringify(clean), webSearch !== false, actor]);
  });
}

// A client for the organization's provider, or a clear reason there isn't one.
export async function aiFor(pool, { orgId, key, fetchImpl = globalThis.fetch }) {
  const s = await getAiSettings(pool, { orgId });
  if (s.provider === 'off') fail('AI is off. An admin can connect Claude or OpenRouter in Settings → AI.');
  if (!s.apiKeyEnc) fail('No API key is saved for the AI provider. Add it in Settings → AI.');
  if (!key) fail('The AI key can’t be read: SETTINGS_KEY isn’t set on the server.');
  return { settings: s, client: aiClient({ provider: s.provider, apiKey: decryptSecret(key, s.apiKeyEnc), fetchImpl }) };
}

export function aiClient({ provider, apiKey, fetchImpl = globalThis.fetch }) {
  const post = async (url, headers, body) => {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError' ? 'The AI provider took too long to answer.' : 'Couldn’t reach the AI provider.');
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const why = json?.error?.message ?? json?.error ?? `HTTP ${res.status}`;
      throw new Error(res.status === 401 || res.status === 403 ? 'The AI provider refused the API key.' : `The AI provider said: ${String(why).slice(0, 200)}`);
    }
    return json;
  };

  if (provider === 'anthropic') {
    return {
      provider,
      // files: [{ mediaType, data: Buffer }] — images and PDFs (receipts).
      async ask({ model, system, prompt, webSearch = false, maxTokens = 2000, files = [] }) {
        const blocks = files.map(f => (f.mediaType === 'application/pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(f.data).toString('base64') } }
          : { type: 'image', source: { type: 'base64', media_type: f.mediaType, data: Buffer.from(f.data).toString('base64') } }));
        const messages = [{ role: 'user', content: blocks.length ? [...blocks, { type: 'text', text: prompt }] : prompt }];
        const tools = webSearch ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }] : undefined;
        const usage = { input: 0, output: 0, searches: 0 };
        let content = [];
        // A long search turn can pause; send it back to continue (a few times at most).
        for (let round = 0; round < 4; round++) {
          const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            { model, max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}) });
          usage.input += r.usage?.input_tokens ?? 0;
          usage.output += r.usage?.output_tokens ?? 0;
          usage.searches += r.usage?.server_tool_use?.web_search_requests ?? 0;
          content = [...content, ...(r.content ?? [])];
          if (r.stop_reason !== 'pause_turn') break;
          messages.push({ role: 'assistant', content: r.content });
        }
        const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
        const sources = [];
        for (const b of content) {
          for (const c of b.citations ?? []) if (c.url) sources.push({ url: c.url, title: c.title ?? c.url });
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x.url) sources.push({ url: x.url, title: x.title ?? x.url });
        }
        return { text, sources: dedupe(sources), usage };
      },
    };
  }
  if (provider === 'openrouter') {
    return {
      provider,
      async ask({ model, system, prompt, webSearch = false, maxTokens = 2000, files = [] }) {
        const parts = files.map(f => {
          const url = `data:${f.mediaType};base64,${Buffer.from(f.data).toString('base64')}`;
          return f.mediaType === 'application/pdf' ? { type: 'file', file: { filename: 'receipt.pdf', file_data: url } } : { type: 'image_url', image_url: { url } };
        });
        const r = await post('https://openrouter.ai/api/v1/chat/completions', { authorization: `Bearer ${apiKey}`, 'x-title': 'Financial Books' },
          { model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: parts.length ? [...parts, { type: 'text', text: prompt }] : prompt }],
            ...(webSearch ? { plugins: [{ id: 'web', max_results: 5 }] } : {}) });
        const msg = r.choices?.[0]?.message ?? {};
        const text = typeof msg.content === 'string' ? msg.content : (msg.content ?? []).map(p => p.text ?? '').join('');
        const sources = (msg.annotations ?? []).filter(a => a.type === 'url_citation' && a.url_citation?.url)
          .map(a => ({ url: a.url_citation.url, title: a.url_citation.title ?? a.url_citation.url }));
        return { text, sources: dedupe(sources), usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0, searches: webSearch ? 1 : 0 } };
      },
    };
  }
  fail('AI is off.');
}

const dedupe = list => [...new Map(list.filter(s => /^https?:\/\//.test(s.url)).map(s => [s.url, s])).values()].slice(0, 10);

// Record a call (worked or not) for the usage list in Settings → AI.
export async function logCall(db, { orgId, entityId = null, job, provider, model, usage = {}, ok, error = null, actor }) {
  const { rows: [c] } = await db.query(`INSERT INTO ai_call (org_id, entity_id, job, provider, model, input_tokens, output_tokens, searches, ok, error, actor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING call_id`,
  [orgId, entityId, job, provider, model, usage.input ?? 0, usage.output ?? 0, usage.searches ?? 0, ok, error ? String(error).slice(0, 300) : null, actor]);
  return Number(c.call_id);
}

export async function aiUsage(db, { orgId, days = 30 }) {
  const { rows } = await db.query(`SELECT job, provider, model, count(*)::int AS calls, count(*) FILTER (WHERE NOT ok)::int AS failed,
      sum(input_tokens)::int AS input, sum(output_tokens)::int AS output, sum(searches)::int AS searches
    FROM ai_call WHERE org_id = $1 AND at > now() - make_interval(days => $2) GROUP BY job, provider, model ORDER BY calls DESC`, [orgId, days]);
  return rows;
}
