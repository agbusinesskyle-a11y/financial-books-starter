// lib/views/tax-profile-fields.js
// The company's tax defaults (tax_profile) as form fields, shared by Settings → Company and the add-company form. The Tax setup page
// (lib/views/tax-profile.js) uses the same field names, so all three read and write one record through lib/tax/periods.js.
import { html } from './html.js';
import { field, selectField } from './forms.js';
import { RETURN_TYPE_LABELS, ACTIVITY_KINDS } from '../tax/periods.js';

export const NEW_TAX_VALUES = { returnType: 'none', activityKind: '', taxMethod: 'cash', bookBasis: 'accrual', stateCodes: '', businessCode: '', dateStarted: '', sElectionDate: '', reason: '' };
export const profileValues = p => ({ returnType: p.return_type, activityKind: p.activity_kind ?? '', taxMethod: p.tax_method_default, bookBasis: p.book_basis_default,
  stateCodes: (p.state_codes ?? []).join(', '), businessCode: p.business_code ?? '', dateStarted: p.date_started ?? '', sElectionDate: p.s_election_date ?? '', reason: '' });
const NAMES = [['returnType', 'return_type'], ['activityKind', 'activity_kind'], ['taxMethod', 'tax_method'], ['bookBasis', 'book_basis'], ['stateCodes', 'state_codes'],
  ['businessCode', 'business_code'], ['dateStarted', 'date_started'], ['sElectionDate', 's_election_date'], ['reason', 'reason']];
export const profileFromForm = form => Object.fromEntries(NAMES.map(([k, n]) => [k, form.get(n) ?? '']));
// The form's values as saveProfile fields. accountantMayEdit is passed through: only the Tax setup page's admin checkbox changes it.
export const profileFields = (v, accountantMayEdit) => ({ returnType: v.returnType, activityKind: v.activityKind || null, taxMethodDefault: v.taxMethod, bookBasisDefault: v.bookBasis,
  yearEndMonth: 12, stateCodes: v.stateCodes, businessCode: v.businessCode, dateStarted: v.dateStarted, sElectionDate: v.sElectionDate, accountantMayEdit });
export const suggestionText = s => (s ? `Suggested from the business type: ${s.returnType ? RETURN_TYPE_LABELS[s.returnType] : 'none that Tax Books prepares'}. ${s.note}` : '');

export function taxProfileFields(v, { suggestion = null, withReason = true } = {}) {
  return html`<div class="form-grid">
    ${selectField('Return filed', 'return_type', Object.entries(RETURN_TYPE_LABELS), v.returnType)}
    ${selectField('If disregarded, kind of activity', 'activity_kind', ACTIVITY_KINDS, v.activityKind, { blank: '—' })}
    ${selectField('Tax method', 'tax_method', [['cash', 'Cash'], ['accrual', 'Accrual']], v.taxMethod)}
    ${selectField('Books kept on', 'book_basis', [['accrual', 'Accrual'], ['cash', 'Cash']], v.bookBasis)}
    ${field('States (two-letter codes)', 'state_codes', v.stateCodes)}
    ${field('Business code (NAICS)', 'business_code', v.businessCode, { attrs: 'inputmode="numeric"' })}
    ${field('Date started', 'date_started', v.dateStarted, { type: 'date' })}
    ${field('S election date', 's_election_date', v.sElectionDate, { type: 'date' })}
    ${withReason ? field('Reason for change', 'reason', v.reason, { hint: 'Needed when the return type or a method changes.' }) : ''}
  </div>${suggestion ? html`<p class="muted small">${suggestionText(suggestion)}</p>` : ''}`;
}
