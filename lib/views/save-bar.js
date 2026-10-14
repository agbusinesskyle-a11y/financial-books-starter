import { html } from './html.js';
import { choiceLabel, ordered, SHORTCUT } from '../domain/save-choices.js';

// The split save button at the bottom of every form (stage F1): the main choice as the primary button (also what Enter
// does), the other choices in a menu, each a plain submit button (works without JavaScript). Ctrl+Alt+S / D / M press the
// matching button (public/app.js). `back` is where "close" returns to. `extra` (e.g. "Save anyway") comes after the main
// button, so Enter still does the main choice.
export function saveBar({ type, preferred = null, cancelHref, back = '', extra = '' }) {
  const [main, ...rest] = ordered(type, preferred);
  const key = c => (SHORTCUT[c] ? html` data-shortcut="${SHORTCUT[c].toLowerCase()}"` : '');
  const hint = c => (SHORTCUT[c] ? html` <kbd>Ctrl+Alt+${SHORTCUT[c]}</kbd>` : '');
  return html`<div class="form-actions save-bar">
    ${back ? html`<input type="hidden" name="back" value="${back}">` : ''}
    <a href="${cancelHref}">Cancel</a>
    <span class="split-save">
      <button class="primary" name="then" value="${main}"${key(main)}>${choiceLabel(type, main)}</button>
      ${rest.length ? html`<details class="split-menu"><summary class="button primary" aria-label="More ways to save"><span aria-hidden="true">▾</span></summary>
        <div class="split-menu-list" role="menu">${rest.map(c => html`<button role="menuitem" name="then" value="${c}"${key(c)}>${choiceLabel(type, c)}${hint(c)}</button>`)}</div>
      </details>` : ''}
    </span>${extra}
  </div>`;
}
