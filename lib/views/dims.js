import { html } from './html.js';
import { selectField } from './forms.js';

// Class, location and tag pickers for a transaction editor. dims: dimensionChoices() output (or null when not loaded).
// v: { classId, locationId, tagIds }. Only what Settings → Accounting turns on (and tags that exist) is shown.
export function dimensionFields(dims, v) {
  if (!dims) return '';
  const { settings: s, classes, locations, tags } = dims;
  const classAtTxn = s.classesOn && s.classMode === 'txn';
  if (!classAtTxn && !s.locationsOn && !tags.length) return '';
  const chosen = new Set((v.tagIds ?? []).map(String));
  return html`<div class="form-grid dims">
    ${classAtTxn ? selectField('Class', 'class_id', classes.map(c => [c.class_id, c.full_name]), v.classId, { blank: '—' }) : ''}
    ${s.locationsOn ? selectField(s.locationLabel, 'location_id', locations.map(l => [l.location_id, l.name]), v.locationId, { blank: '—' }) : ''}
    ${tags.length ? html`<label class="field"><span>Tags</span><input type="hidden" name="tags_shown" value="1">
      <select name="tag_ids" multiple size="${Math.min(4, tags.length)}">${tags.map(t => html`<option value="${t.tag_id}"${chosen.has(String(t.tag_id)) ? html` selected` : ''}>${t.full_name}</option>`)}</select></label>` : ''}
  </div>`;
}

// Whether lines get their own class column.
export const lineClasses = dims => Boolean(dims?.settings.classesOn && dims.settings.classMode === 'line');

export const lineClassSelect = (name, classes, value, label = 'Class') => html`<select name="${name}" aria-label="${label}"><option value="">—</option>
  ${classes.map(c => html`<option value="${c.class_id}"${String(c.class_id) === String(value ?? '') ? html` selected` : ''}>${c.full_name}</option>`)}</select>`;
