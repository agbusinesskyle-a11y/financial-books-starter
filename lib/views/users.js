import { html } from './html.js';
import { layout } from './layout.js';
import { settingsLayout } from './settings.js';
import { csrfField, errorBanner, field, checkbox, postButton } from './forms.js';
import { formatDateTime } from './format.js';
import { ROLES, ROLE_LABELS } from '../domain/roles.js';
import { MIN_PASSWORD } from '../data/users.js';

const STATUS = { active: ['Active', 'good'], invited: ['Invited', 'warn'], invite_expired: ['Invite expired', 'bad'], inactive: ['Inactive', 'muted'] };
const statusBadge = s => html`<span class="status ${STATUS[s][1]}">${STATUS[s][0]}</span>`;

export function usersBody({ users, owner, timeZone }) {
  return html`<div class="card-head"><h2>Users</h2><a class="button primary" href="/settings/users/new">Invite a user</a></div>
<p class="muted">Each person signs in with their own email, password and authenticator app. What they can open depends on their role.</p>
<table class="grid">
  <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Approves bills</th><th>Status</th><th>Last sign-in</th></tr></thead>
  <tbody>
  ${users.map(u => html`<tr>
    <td data-label="Name"><a href="/settings/users/${u.user_id}">${u.name}</a></td>
    <td data-label="Email">${u.email}</td>
    <td data-label="Role">${ROLE_LABELS[u.role]}</td>
    <td data-label="Approves bills">${u.can_approve_bills ? 'Yes' : 'No'}</td>
    <td data-label="Status">${statusBadge(u.status)}</td>
    <td data-label="Last sign-in">${u.last_login_at ? formatDateTime(u.last_login_at, timeZone) : '—'}</td>
  </tr>`)}
  ${owner ? html`<tr class="owner-row">
    <td data-label="Name">${owner.name}</td>
    <td data-label="Email"><span class="muted">Owner sign-in (no email)</span></td>
    <td data-label="Role">Admin</td>
    <td data-label="Approves bills">Yes</td>
    <td data-label="Status"><span class="status muted">Break-glass</span></td>
    <td data-label="Last sign-in">—</td>
  </tr>` : ''}
  </tbody>
</table>
${owner ? html`<p class="muted small">The <strong>owner sign-in</strong> comes from the server’s settings (leave Email blank on the sign-in page).
It always works as an admin so nobody is ever locked out. Keep its password and authenticator somewhere safe.</p>` : ''}`;
}

export const userToValues = u => ({ name: u.name, email: u.email, role: u.role, canApproveBills: u.can_approve_bills, allCompanies: u.all_companies !== false,
  companyIds: (u.company_ids ?? []).map(Number) });
export const userFormValues = params => ({ name: params.get('name') ?? '', email: params.get('email') ?? '', role: params.get('role') ?? '',
  canApproveBills: params.get('canApproveBills') === '1',
  // Without the Companies section (one company only) the person keeps access to all companies.
  allCompanies: !params.has('companyAccess') || params.get('allCompanies') === '1', companyIds: params.getAll('company').map(Number).filter(Number.isSafeInteger) });
export const NEW_USER_VALUES = { name: '', email: '', role: 'standard', canApproveBills: false, allCompanies: true, companyIds: [] };

// Which companies the person can open (only shown when the account has more than one company).
const companyChoices = (v, companies) => (companies.length > 1 ? html`<fieldset class="choice companies"><legend>Companies</legend>
  <input type="hidden" name="companyAccess" value="1">
  ${checkbox('All companies, including ones added later', 'allCompanies', v.allCompanies !== false)}
  <p class="muted small">Or only these:</p>
  ${companies.map(c => html`<label class="check"><input type="checkbox" name="company" value="${c.entity_id}"${(v.companyIds ?? []).includes(Number(c.entity_id)) ? html` checked` : ''}> ${c.name}</label>`)}
</fieldset>` : '');

const roleChoices = v => html`<fieldset class="choice roles"><legend>Role</legend>
  ${ROLES.map(([key, label, about]) => html`<label class="check"><input type="radio" name="role" value="${key}"${v.role === key ? html` checked` : ''} required>
    <span><strong>${label}</strong> <small class="muted">${about}</small></span></label>`)}
</fieldset>`;

// forAccountant: "My accountant" (Accounting menu) — the same invite, set up for an accountant.
export function userFormBody({ csrf, user = null, v, error = null, timeZone, selfId, companies = [], forAccountant = false, readOnly = false }) {
  if (readOnly) return html`<p><a href="/settings/users">‹ Users</a></p><h2>${user.name}</h2>
    <p>This person is a Morning View viewer; only the owner can change them.</p><p>${user.email} · ${ROLE_LABELS[user.role]}</p>`;
  const action = user ? `/settings/users/${user.user_id}` : '/settings/users';
  return html`<p><a href="/settings/users">‹ Users</a></p>
<h2>${user ? user.name : forAccountant ? 'Invite your accountant' : 'Invite a user'}</h2>
${forAccountant ? html`<p class="muted">They get their own sign-in. As a Standard user they can see every report and record and make adjusting entries, but
  can’t manage users or company settings. Choose Reports only if they should only look.</p>` : ''}
${user ? html`<p>${statusBadge(user.status)}${user.status === 'invited' && user.invite_expires_at ? html` <span class="muted">Link good until ${formatDateTime(user.invite_expires_at, timeZone)}</span>` : ''}
  ${user.invited_by ? html` <span class="muted">· Invited by ${user.invited_by}</span>` : ''}</p>` : ''}
<form method="post" action="${action}" class="editor">
  ${csrfField(csrf)}
  ${errorBanner(error)}
  <div class="form-grid">
    ${field('Name', 'name', v.name, { required: true })}
    ${field('Email', 'email', v.email, { type: 'email', required: true, hint: 'They sign in with this address.' })}
  </div>
  ${roleChoices(v)}
  ${companyChoices(v, companies)}
  ${checkbox('Can approve bills', 'canApproveBills', v.canApproveBills)}
  <p class="muted small">${user ? '' : 'They’ll get a link (good for 7 days) to set a password and connect an authenticator app.'}</p>
  <div class="form-actions"><button class="primary">${user ? 'Save' : 'Send invite'}</button></div>
</form>
${user ? html`<section class="user-actions">
  <h2>Sign-in</h2>
  <div class="page-actions">
    ${user.active && !user.password_hash ? postButton({ action: `/settings/users/${user.user_id}/resend`, csrf, label: 'Send a new invite link', cls: 'button' }) : ''}
    ${user.active && user.password_hash ? postButton({ action: `/settings/users/${user.user_id}/reset`, csrf, label: 'Reset sign-in', cls: 'button',
      confirm: `Reset ${user.name}’s sign-in? Their password and authenticator stop working now, and they get a new link to set them up again.` }) : ''}
    ${user.user_id === selfId ? '' : user.active
      ? postButton({ action: `/settings/users/${user.user_id}/deactivate`, csrf, label: 'Make inactive', cls: 'button', confirm: `Make ${user.name} inactive? They’re signed out at once.` })
      : postButton({ action: `/settings/users/${user.user_id}/activate`, csrf, label: 'Make active', cls: 'button' })}
  </div>
</section>` : ''}`;
}

// After an invite or reset: the link, shown once so it can be copied if email isn't set up.
export function inviteSentBody({ user, link, status, ownerCopyOnly = false }) {
  const said = ownerCopyOnly ? html`Copy this link and give it to the second viewer yourself. It was not emailed.` : { sent: html`We emailed the link to <strong>${user.email}</strong>.`,
    logged: html`Email isn’t set up yet (Settings → Email), so nothing was sent. Copy the link below and send it to ${user.name} yourself.`,
    failed: html`The email to ${user.email} failed. Copy the link below and send it yourself.` }[status];
  return html`<p><a href="/settings/users">‹ Users</a></p>
<h2>Invite link for ${user.name}</h2>
<p>${said}</p>
<label class="field wide"><span>One-time link (good for 7 days)</span><input readonly value="${link}" data-select-all></label>
<p class="muted small">This page is the only place the link is shown. It works once; if it’s lost, send a new one from ${user.name}’s page.</p>
<p><a class="button" href="/settings/users/${user.user_id}">Done</a></p>`;
}

export const usersPage = ({ entityName, csrf, flash, role, body }) => settingsLayout({ entityName, csrf, flash, tab: 'users', role, body });

// ---- the public invite page ----

export function inviteSetupPage({ invite, nonce, qrSvg, secret, error = null }) {
  return layout({
    title: 'Set up your sign-in', entityName: invite.entity_name, bare: true,
    body: html`<section class="card editor public-form invite-setup">
  <h1>Welcome, ${invite.name}</h1>
  <p>You’ve been invited to ${invite.entity_name}’s books as <strong>${ROLE_LABELS[invite.role]}</strong>. You’ll sign in with <strong>${invite.email}</strong>.</p>
  ${errorBanner(error)}
  <form method="post">
    <input type="hidden" name="nonce" value="${nonce}">
    <h2>1. Choose a password</h2>
    <div class="form-grid">
      <label class="field"><span>Password (${MIN_PASSWORD}+ characters)</span><input type="password" name="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
      <label class="field"><span>Password again</span><input type="password" name="password2" autocomplete="new-password" minlength="${MIN_PASSWORD}" required></label>
    </div>
    <h2>2. Connect an authenticator app</h2>
    <p class="muted">Scan this with Google Authenticator, Microsoft Authenticator, 1Password or similar.</p>
    <p class="qr"><img src="data:image/svg+xml;base64,${Buffer.from(qrSvg).toString('base64')}" alt="Authenticator QR code" width="200" height="200"></p>
    <details><summary>Can’t scan? Enter this key instead</summary><p><code class="secret">${secret.replace(/(.{4})/g, '$1 ').trim()}</code></p></details>
    <h2>3. Enter the 6-digit code it shows</h2>
    <div class="form-grid"><label class="field"><span>Authenticator code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label></div>
    <div class="form-actions"><button class="primary">Finish and sign in</button></div>
  </form>
</section>`,
  });
}
