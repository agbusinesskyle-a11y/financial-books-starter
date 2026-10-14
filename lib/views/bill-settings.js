import { html } from './html.js';
import { csrfField, errorBanner, field, checkbox } from './forms.js';

export function billSettingsBody({ csrf, v, error = null }) {
  return html`<form method="post" action="/settings/bills" class="editor">
  ${csrfField(csrf)}
  <p class="muted">How bills are approved and how checks are numbered.</p>
  ${errorBanner(error)}
  ${checkbox('Bills need approval before they can be paid', 'requireApproval', v.requireApproval)}
  <p class="muted">People with “Can approve bills” turned on (Settings → Users) can approve or reject a bill; the name and time are recorded. Changing an approved bill’s amount sends it back for approval.</p>
  <div class="form-grid">
    ${field('Starting check number', 'nextCheckNumber', v.nextCheckNumber, { attrs: 'inputmode="numeric"', hint: 'New checks use the next number after the highest one already written on that bank account, but never lower than this.' })}
  </div>
  <div class="form-actions"><button class="primary">Save</button></div>
</form>`;
}
