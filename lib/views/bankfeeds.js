import { html } from './html.js';
import { settingsLayout } from './settings.js';
import { csrfField, errorBanner, postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { formatCents } from '../domain/money.js';
import { formatShortDate } from '../domain/dates.js';
import { KIND_LABEL } from '../data/bankfeeds.js';

// Settings → Bank connections (stage B2): link the company to its ledgerline company, map each bank, card and loan
// account to a books account once, refresh, and see what each pull brought in.
export function bankFeedsPage({ entityName, csrf, flash, role, orgAdmin, timeZone, connected, link, choices = [], accounts = [], mapping, pulls = [], error = null, canRefresh = true }) {
  const body = !connected ? notConnected()
    : !link ? linkForm({ csrf, choices, error })
    : html`${errorBanner(error)}
  <div class="card">
    <div class="page-actions"><div><h2>Ledgerline</h2>
      <p>Linked to <strong>${link.ll_entity_name}</strong> in ledgerline. ${link.last_pull_at ? html`Last pulled ${formatDateTime(link.last_pull_at, timeZone)}.` : 'Not pulled yet.'}</p>
      <p class="muted small">New bank items come in after each ledgerline sync (about every 3 hours). Read-only: nothing is written back to ledgerline or the bank.</p></div>
      <span class="spacer"></span>
      ${canRefresh ? postButton({ action: '/bank-feeds/refresh', csrf, label: 'Refresh now', cls: 'primary' }) : ''}
    </div>
  </div>
  ${accountsForm({ csrf, accounts, mapping, timeZone })}
  ${pullsTable(pulls, timeZone)}
  <p>${postButton({ action: '/settings/bank-feeds/unlink', csrf, label: 'Unlink from ledgerline', confirm: 'Unlink this company from ledgerline? Bank items not yet reviewed are removed.' })}</p>`;
  return settingsLayout({ entityName, csrf, flash, role, orgAdmin, tab: 'bank-feeds', body: html`<h2>Bank connections</h2>${body}` });
}

const notConnected = () => html`<div class="card"><h2>Ledgerline isn’t connected</h2>
  <p>Bank and card transactions come from ledgerline, which reads the banks. To connect it, set <code>LEDGERLINE_URL</code> to ledgerline’s
  read-only address (a read-only database role) and restart.</p></div>`;

const linkForm = ({ csrf, choices, error }) => html`<form method="post" action="/settings/bank-feeds/link" class="card editor">${csrfField(csrf)}
  <h2>Link to ledgerline</h2>${errorBanner(error)}
  <p class="muted">Choose which of ledgerline’s companies is this company. Its bank, card and loan accounts are listed next so you can match each one to an account in these books.</p>
  ${choices.length ? html`<label class="field"><span>Ledgerline company</span><select name="ll_entity_id" required><option value="">Choose…</option>
    ${choices.map(c => html`<option value="${c.id}">${c.name}${c.legal_form ? ` (${c.legal_form.toUpperCase()})` : ''}</option>`)}</select></label>
  <div class="form-actions"><button class="primary">Link</button></div>`
  : html`<p>Every ledgerline company is already linked to another company here.</p>`}
</form>`;

function accountsForm({ csrf, accounts, mapping, timeZone }) {
  if (!accounts.length) return html`<div class="card"><h2>Accounts</h2><p class="muted">No accounts yet — refresh to bring in this company’s accounts from ledgerline.</p></div>`;
  return html`<form method="post" action="/settings/bank-feeds/accounts" class="card editor">${csrfField(csrf)}
  <h2>Accounts</h2>
  <p class="muted small">Match each account once. Transactions from the start date on come into Bank transactions for review; leave the start date empty to bring in everything ledgerline has.</p>
  <div class="table-scroll"><table class="grid bank-feed-accounts">
    <thead><tr><th>Bank account</th><th class="num">Bank balance</th><th>Verified</th><th>Books account</th><th>Start date</th><th class="num">Items</th></tr></thead>
    <tbody>${accounts.map(a => {
      const m = mapping.get(a.id);
      const value = !a.include ? 'skip' : a.books_account_id ? String(a.books_account_id) : '';
      return html`<tr>
        <td><input type="hidden" name="account" value="${a.id}"><strong>${a.display_name}</strong>
          <small class="muted">${KIND_LABEL[a.kind] ?? a.kind}${a.institution_name ? ` · ${a.institution_name}` : ''}${a.mask ? ` ••${a.mask}` : ''}</small>
          ${a.connection_state && a.connection_state !== 'healthy' ? html`<small class="warn">Connection: ${a.connection_state}</small>` : ''}</td>
        <td class="num">${a.bank_balance_cents === null ? '—' : formatCents(Number(a.bank_balance_cents))}
          ${a.balance_as_of ? html`<small class="muted">${a.balance_stale ? 'Old: ' : ''}${formatDateTime(a.balance_as_of, timeZone)}</small>` : ''}</td>
        <td>${a.verified_through ? html`<span class="tag ok">Through ${formatShortDate(a.verified_through)}</span>` : html`<span class="muted">Not yet</span>`}</td>
        <td><label class="field compact"><span class="visually-hidden">Books account for ${a.display_name}</span><select name="books_${a.id}">
          <option value=""${value === '' ? html` selected` : ''}>Choose…</option>
          ${m.accounts.map(b => html`<option value="${b.account_id}"${value === String(b.account_id) || (value === '' && Number(b.account_id) === m.suggested) ? html` selected` : ''}>${b.name}${Number(b.account_id) === m.suggested && value === '' ? ' (suggested)' : ''}</option>`)}
          <option value="new">Add a new account: ${a.mask ? `${a.display_name} (${a.mask})` : a.display_name}</option>
          <option value="skip"${value === 'skip' ? html` selected` : ''}>Don’t bring in</option>
        </select></label>
        ${a.books_account_id ? '' : html`<small class="muted">Not matched yet</small>`}</td>
        <td><label class="field compact"><span class="visually-hidden">Start date for ${a.display_name}</span><input type="date" name="start_${a.id}" value="${a.start_date ?? ''}"></label></td>
        <td class="num">${a.items}${a.pending ? html`<small class="muted">${a.pending} pending</small>` : ''}${a.attention ? html`<small class="warn">${a.attention} need a look</small>` : ''}</td>
      </tr>`;
    })}</tbody>
  </table></div>
  <div class="form-actions"><button class="primary">Save accounts</button></div>
</form>`;
}

const PULL_TRIGGER = { schedule: 'After a ledgerline sync', refresh: 'Refresh', link: 'Linked' };
const pullsTable = (pulls, timeZone) => (pulls.length ? html`<div class="card"><h2>Recent pulls</h2><div class="table-scroll"><table class="grid">
  <thead><tr><th>When</th><th>Why</th><th>Result</th><th class="num">New</th><th class="num">Updated</th><th class="num">Removed</th></tr></thead>
  <tbody>${pulls.map(p => html`<tr><td>${formatDateTime(p.started_at, timeZone)}</td><td>${PULL_TRIGGER[p.trigger] ?? p.trigger}</td>
    <td>${p.status === 'ok' ? 'OK' : p.status === 'running' ? 'Running' : html`<span class="warn">Failed: ${p.error}</span>`}${p.warning ? html`<small class="warn">${p.warning}</small>` : ''}</td>
    <td class="num">${p.new_count}</td><td class="num">${p.updated_count}</td><td class="num">${p.removed_count}</td></tr>`)}</tbody>
</table></div></div>` : '');
