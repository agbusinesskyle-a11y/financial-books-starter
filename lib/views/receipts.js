import { html } from './html.js';
import { layout } from './layout.js';
import { settingsLayout } from './settings.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { TYPE_LABELS } from '../domain/status.js';
import { linkOf } from './accounts.js';

// Receipts (stage B8): texted receipts by status, and Settings → Text receipts.

const TABS = [['review', 'Needs a look'], ['waiting', 'Waiting for the charge'], ['added', 'In the books'], ['all', 'All']];
const STATUS = { received: 'Being read', needs_company: 'Which company?', waiting: 'Waiting for the charge', review: 'Needs a look', added: 'In the books',
  rejected: 'Rejected', failed: 'Couldn’t be read' };

export function receiptsPage({ entityName, csrf, flash, timeZone, tab, receipts, counts, canReview, smsOn, canSetUp }) {
  return layout({ title: 'Receipts', entityName, csrf, flash, body: html`<h1>Receipts</h1>
  <p class="muted">${smsOn ? 'Receipts texted to the company’s number are read, matched to their bank or card charge, and added when everything lines up.'
    : html`Text-a-receipt is off.${canSetUp ? html` Connect a Twilio number in <a href="/settings/text-receipts">Settings → Text receipts</a>.` : ''}`}</p>
  <nav class="tabs" aria-label="Receipt tabs">${TABS.map(([k, l]) => html`<a class="${k === tab ? 'tab active' : 'tab'}" href="/receipts?tab=${k}"${k === tab ? html` aria-current="page"` : ''}>${l} (${counts[k]})</a>`)}</nav>
  ${receipts.length ? html`<div class="table-scroll"><table class="grid receipts">
    <thead><tr><th>Receipt</th><th>Received</th><th>From</th><th>Vendor</th><th class="num">Total</th><th>Status</th><th class="actions"></th></tr></thead>
    <tbody>${receipts.map(r => {
      const x = r.extracted ?? {};
      return html`<tr>
      <td><a href="/receipts/${r.receipt_id}/image" target="_blank" rel="noopener">${r.content_type === 'application/pdf' ? 'PDF' : html`<img src="/receipts/${r.receipt_id}/image" alt="Receipt" class="receipt-thumb" loading="lazy">`}</a></td>
      <td>${formatDateTime(r.created_at, timeZone)}${x.date ? html`<small class="muted">Dated ${formatShortDate(x.date)}</small>` : ''}</td>
      <td>${r.sender_name ?? r.from_phone}${r.body ? html`<small class="muted">“${r.body}”</small>` : ''}</td>
      <td>${r.vendor_name ?? x.vendor ?? '—'}${r.account_name ? html`<small class="muted">${r.account_name}</small>` : ''}</td>
      <td class="num">${x.total_cents ? formatCents(x.total_cents) : '—'}</td>
      <td>${STATUS[r.status] ?? r.status}${r.note ? html`<small class="muted">${r.note}</small>` : ''}
        ${r.txn_id ? html`<small><a href="${linkOf({ type: r.txn_type, txn_id: r.txn_id })}">${TYPE_LABELS[r.txn_type] ?? 'Transaction'} ${r.doc_number ?? ''}</a></small>` : ''}</td>
      <td class="actions">${canReview ? actions(r, csrf) : ''}</td>
    </tr>`;
    })}</tbody></table></div>` : html`<p class="muted">Nothing here.</p>`}` });
}

function actions(r, csrf) {
  const out = [];
  if (r.status === 'review' && r.item_id) {
    const q = new URLSearchParams();
    if (r.vendor_id) q.set('payee', `v:${r.vendor_id}`);
    if (r.account_id) q.set('category', String(r.account_id));
    out.push(html`<a href="/banking/item/${r.item_id}${q.size ? `?${q}` : ''}">Review the charge</a>`);
  }
  if (['needs_company', 'review', 'waiting'].includes(r.status) && r.extracted) out.push(postButton({ action: `/receipts/${r.receipt_id}/assign`, csrf, label: r.status === 'needs_company' ? 'It’s this company' : 'Try again' }));
  if (!['added', 'rejected'].includes(r.status)) out.push(postButton({ action: `/receipts/${r.receipt_id}/reject`, csrf, label: 'Reject', confirm: 'Reject this receipt?' }));
  return out.map((a, i) => html`${i ? html`<br>` : ''}${a}`);
}

export function textReceiptsSettings({ entityName, csrf, flash, role, orgAdmin, s, senders, companies, webhookUrl, error = null, v = null, timeZone }) {
  const val = v ?? { enabled: s.enabled, accountSid: s.accountSid, phone: s.phone };
  return settingsLayout({ entityName, csrf, flash, role, orgAdmin, tab: 'text-receipts', body: html`<h2>Text receipts</h2>${errorBanner(error)}
  <form method="post" action="/settings/text-receipts" class="card editor">${csrfField(csrf)}
    <p class="muted">People you approve text a photo of a receipt to your Twilio number, with the company’s name or nickname. Each is read by AI (Settings → AI),
      matched to its bank or card charge, and added when everything lines up; they get a text back. Twilio charges per text.</p>
    <div class="form-grid">
      <label class="field"><span>Account SID</span><input name="accountSid" value="${val.accountSid}" autocomplete="off" placeholder="AC…"></label>
      <label class="field"><span>Auth token</span><input type="password" name="authToken" autocomplete="off" value="" placeholder="${s.hasToken ? 'Saved — leave empty to keep it' : 'From the Twilio console'}"></label>
      <label class="field"><span>Twilio number</span><input name="phone" value="${val.phone}" inputmode="tel" placeholder="+1 202 555 0100"></label>
    </div>
    <p class="small">In Twilio, set the number’s “A message comes in” webhook to <code>${webhookUrl}</code> (HTTP POST).</p>
    <label class="check"><input type="checkbox" name="enabled" value="1"${val.enabled ? html` checked` : ''}> Text receipts are on</label>
    <div class="form-actions"><button class="primary" name="section" value="twilio">Save</button></div>
    ${s.updatedBy ? html`<p class="muted small">Last changed by ${s.updatedBy}, ${formatDateTime(s.updatedAt, timeZone)}.</p>` : ''}
  </form>
  <form method="post" action="/settings/text-receipts" class="card editor">${csrfField(csrf)}
    <h3>Company nicknames</h3>
    <p class="muted small">What people can text for each company, separated by commas (small typos are fine). If a text names no company, the card’s last 4 digits on
      the receipt decide; if that doesn’t, they get a text asking which one.</p>
    ${companies.map(c => html`<label class="field"><span>${c.name}</span><input name="nick_${c.entityId}" value="${c.nicknames.join(', ')}" placeholder="e.g. CF, Sample Feed"></label>`)}
    <div class="form-actions"><button class="primary" name="section" value="nicknames">Save nicknames</button></div>
  </form>
  <div class="card"><h3>Who can text receipts</h3>
    ${senders.length ? html`<ul class="link-list">${senders.map(p => html`<li><div><strong>${p.name}</strong> <span class="muted">${p.phone}</span>
      <small class="muted">${p.all_companies ? 'All companies' : companies.filter(c => p.company_ids.includes(c.entityId)).map(c => c.name).join(', ')}${p.active ? '' : ' · off'}</small></div>
      ${postButton({ action: `/settings/text-receipts/senders/${p.sender_id}/delete`, csrf, label: 'Remove', confirm: `Stop accepting receipts from ${p.name}?` })}</li>`)}</ul>`
    : html`<p class="muted">Nobody yet. Texts from numbers not on this list get no answer.</p>`}
    <form method="post" action="/settings/text-receipts/senders" class="editor">${csrfField(csrf)}
      <div class="form-grid">
        <label class="field"><span>Name</span><input name="name" required></label>
        <label class="field"><span>Mobile number</span><input name="phone" inputmode="tel" required placeholder="(202) 555-0109"></label>
      </div>
      <label class="check"><input type="checkbox" name="allCompanies" value="1" checked> Any company</label>
      <p class="muted small">Or only these:</p>
      ${companies.map(c => html`<label class="check"><input type="checkbox" name="company" value="${c.entityId}"> ${c.name}</label>`)}
      <div class="form-actions"><button class="primary">Add</button></div>
    </form>
  </div>` });
}
