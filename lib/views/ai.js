import { html } from './html.js';
import { settingsLayout } from './settings.js';
import { csrfField, errorBanner } from './forms.js';
import { formatDateTime } from './format.js';
import { PROVIDERS, JOBS } from '../ai/provider.js';

// Settings → AI (stage B5): provider, API key, the model for each job, web search, and the last 30 days' use.
export function aiSettingsPage({ entityName, csrf, flash, role, orgAdmin, timeZone, s, usage, v = null, error = null, hasSettingsKey }) {
  const val = v ?? { provider: s.provider, models: s.models, webSearch: s.webSearch };
  const opt = (value, label, current) => html`<option value="${value}"${String(current) === String(value) ? html` selected` : ''}>${label}</option>`;
  return settingsLayout({ entityName, csrf, flash, role, orgAdmin, tab: 'ai', body: html`<h2>AI</h2>
  <form method="post" action="/settings/ai" class="card editor">${csrfField(csrf)}${errorBanner(error)}
    <p class="muted">AI researches bank payees the books don’t recognize and reads texted receipts. Choose <strong>Claude</strong> to use Anthropic directly, or
      <strong>OpenRouter</strong> to pick any model per job. What a job needs — bank descriptions, vendor and category names — is sent to that provider.
      Nothing is sent while AI is off.</p>
    <div class="form-grid">
      <label class="field"><span>Provider</span><select name="provider">${Object.entries(PROVIDERS).map(([k, l]) => opt(k, l, val.provider))}</select></label>
      <label class="field"><span>API key</span><input type="password" name="apiKey" autocomplete="off" value="" placeholder="${s.hasKey ? 'Saved — leave empty to keep it' : 'Paste the key'}">
        <small class="muted">${hasSettingsKey ? 'Stored encrypted.' : 'Saving a key needs SETTINGS_KEY set on the server.'}</small></label>
    </div>
    <h3>Model for each job</h3>
    <div class="form-grid">${Object.entries(JOBS).map(([job, j]) => html`<label class="field"><span>${j.label}</span>
      <input name="model_${job}" value="${val.models?.[job] ?? ''}" placeholder="${j.defaults[val.provider] ?? j.defaults.anthropic}"><small class="muted">${j.about}. Empty uses the default shown.</small></label>`)}</div>
    <label class="check"><input type="checkbox" name="webSearch" value="1"${val.webSearch === false ? '' : html` checked`}> Let AI search the web</label>
    <div class="form-actions"><button class="primary">Save</button></div>
    ${s.updatedBy ? html`<p class="muted small">Last changed by ${s.updatedBy}, ${formatDateTime(s.updatedAt, timeZone)}.</p>` : ''}
  </form>
  <div class="card"><h2>Use in the last 30 days</h2>
    ${usage.length ? html`<div class="table-scroll"><table class="grid"><thead><tr><th>Job</th><th>Model</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Tokens in</th><th class="num">Tokens out</th><th class="num">Searches</th></tr></thead>
      <tbody>${usage.map(u => html`<tr><td>${JOBS[u.job]?.label ?? u.job}</td><td>${u.model}</td><td class="num">${u.calls}</td><td class="num">${u.failed}</td>
        <td class="num">${u.input}</td><td class="num">${u.output}</td><td class="num">${u.searches}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">No AI calls yet.</p>`}
  </div>` });
}
