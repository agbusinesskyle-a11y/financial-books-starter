import { html } from './html.js';
import { layout } from './layout.js';

export function loginPage({ challenge, error = null, next = '/customers', email = '' }) {
  return layout({
    title: 'Sign in',
    body: html`<section class="card login">
  <h1>Sign in</h1>
  ${error ? html`<p class="error" role="alert">${error}</p>` : ''}
  <form method="post" action="/login">
    <input type="hidden" name="challenge" value="${challenge}">
    <input type="hidden" name="next" value="${next}">
    <label>Email <input type="email" name="email" value="${email}" autocomplete="username" autofocus>
      <small class="muted">Leave blank for the owner sign-in.</small></label>
    <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
    <label>Authenticator code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label>
    <button class="primary">Sign in</button>
  </form>
</section>`,
  });
}
