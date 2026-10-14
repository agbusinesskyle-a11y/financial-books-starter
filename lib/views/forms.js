import { randomBytes } from 'node:crypto';
import { html, raw } from './html.js';

// `attrs` / option `extra` are attribute strings written by this codebase (never user data).

// With the CSRF token, a one-time form id: the server ignores a second submit of the same rendered form (a double tap
// on a phone, a resent request), so nothing is saved or emailed twice.
export const csrfField = csrf => html`<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="form_once" value="${randomBytes(12).toString('base64url')}">`;

export const errorBanner = error => (error ? html`<p class="error-banner" role="alert">${error}</p>` : '');

export function field(label, name, value, { type = 'text', required = false, attrs = '', hint = '', cls = '' } = {}) {
  return html`<label class="${`field ${cls}`.trim()}"><span>${label}${required ? html` <span class="req">*</span>` : ''}</span>
    <input type="${type}" name="${name}" value="${value ?? ''}"${required ? html` required` : ''}${attrs ? raw(` ${attrs}`) : ''}>
    ${hint ? html`<small class="muted">${hint}</small>` : ''}</label>`;
}

export function selectField(label, name, options, value, { blank = null, attrs = '', cls = '' } = {}) {
  return html`<label class="${`field ${cls}`.trim()}"><span>${label}</span>
    <select name="${name}"${attrs ? raw(` ${attrs}`) : ''}>
      ${blank !== null ? html`<option value="">${blank}</option>` : ''}
      ${options.map(([v, text, extra]) => html`<option value="${v}"${String(v) === String(value ?? '') ? html` selected` : ''}${extra ? raw(` ${extra}`) : ''}>${text}</option>`)}
    </select></label>`;
}

export function checkbox(label, name, checked) {
  return html`<label class="check"><input type="checkbox" name="${name}" value="1"${checked ? html` checked` : ''}> ${label}</label>`;
}

// A POST button rendered as its own small form (row actions, void/delete/send).
export function postButton({ action, csrf, label, confirm = null, cls = 'link', target = null, extra = {} }) {
  return html`<form method="post" action="${action}" class="inline"${confirm ? html` data-confirm="${confirm}"` : ''}${target ? html` target="${target}"` : ''}>${csrfField(csrf)}${Object.entries(extra).map(([k, val]) => html`<input type="hidden" name="${k}" value="${val}">`)}<button class="${cls}">${label}</button></form>`;
}
